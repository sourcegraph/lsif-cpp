import * as readline from 'readline'
import * as fs from 'fs'
import * as util from 'util'
import { VError } from 'verror'
import {
    fromPairs,
    chunk,
    Dictionary,
    isEqual,
    difference,
    groupBy,
    map as mapObject,
} from 'lodash'
import {
    Document,
    Edge,
    ElementTypes,
    HoverResult,
    // Range,
    MetaData,
    Vertex,
    VertexLabels,
    Moniker,
    PackageInformation,
    Id,
    EdgeLabels,
    ItemEdge,
    V,
    Project,
    EventKind,
    EventScope,
    ProjectEvent,
    DocumentEvent,
    Range,
    ResultSet,
    DefinitionResult,
    ReferenceResult,
    contains,
    next,
    textDocument_definition,
    item,
    textDocument_references,
    ItemEdgeProperties,
} from 'lsif-protocol'
import * as lsp from 'vscode-languageserver-protocol'
import * as P from 'parsimmon'
import glob from 'glob'

// Causes node to print all stacks from nested VErrors.
process.on('uncaughtException', error => {
    console.log(error)
    process.exit(1)
})

// What are all of the kinds? According to DXR source code:
//
// rg "^\s*beginRecord" dxr/plugins/clang/dxr-index.cpp | gsed "s/^ *beginRecord..\(\w\+\).*/\1/" | sort
//
// call call decldef func_override function impl include macro namespace namespace_alias ref ref type typedef typedef variable warning
//
// TODO exhaustiveness check: make sure all kinds and fields are used (or at least acknowledged) by this converter.

async function main(): Promise<void> {
    const csvFileGlob =
        '/Users/chrismwendt/github.com/mozilla/dxr/example/*.csv'
    const projectRoot = '/Users/chrismwendt/github.com/mozilla/dxr/example'

    emitMeta(projectRoot, csvFileGlob)
    emitProject()
    emitProjectBegin()

    const docs = new Set<string>()
    const rangesByDoc = new Map<string, Set<string>>()
    const refsByDef = new Map<string, Set<string>>()
    const locByRange = new Map<string, lsp.Location>()

    function onDoc(doc: string): void {
        if (!docs.has(doc)) {
            docs.add(doc)
        }

        if (!rangesByDoc.has(doc)) {
            rangesByDoc.set(doc, new Set())
        }
    }

    function onLoc(loc: lsp.Location): void {
        onDoc(loc.uri)
        const ranges = rangesByDoc.get(loc.uri)
        if (!ranges) {
            throw new Error(`rangesByDoc does not contain ${loc.uri}`)
        }
        if (!ranges.has(stringifyLocation(loc))) {
            ranges.add(stringifyLocation(loc))
        }
        locByRange.set(stringifyLocation(loc), loc)
    }

    function link({
        def,
        ref,
    }: {
        def: lsp.Location
        ref: lsp.Location
    }): void {
        onLoc(def)
        onLoc(ref)

        let refs = refsByDef.get(stringifyLocation(def))
        if (!refs) {
            refs = new Set()
            refsByDef.set(stringifyLocation(def), refs)
        }
        refs.add(stringifyLocation(ref))
    }

    const dp = mkDispatch(link)
    for (const csvFile of glob.sync(csvFileGlob)) {
        await scanCsvFile({ csvFile, cb: dp })
    }

    docs.forEach(doc => emitDocsBegin({ projectRoot, doc }))

    Array.from(locByRange.keys()).forEach((range, _) => {
        const loc = locByRange.get(range)
        if (!loc) {
            throw new Error('Unable to look up loc by range')
        }
        emitRange(loc)
    })

    emitDefsRefs({ refsByDef, locByRange })

    emitDocsEnd({ docs, rangesByDoc })

    emit<contains>({
        id: 'projectContains',
        type: ElementTypes.edge,
        label: EdgeLabels.contains,
        outV: 'project',
        inVs: Array.from(docs).map(doc => 'document:' + doc),
    })

    emitProjectEnd()
}
main()

function stringifyLocation(loc: lsp.Location): string {
    return `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}-${loc.range.end.line}:${loc.range.end.character}`
}

interface FilePosition {
    uri: string
    position: lsp.Position
}

type GenericEntry = { kind: string; value: Dictionary<string> }

type Link = (info: { def: lsp.Location; ref: lsp.Location }) => void

async function scanCsvFile({
    csvFile,
    cb,
}: {
    csvFile: string
    cb: (genericEntry: GenericEntry) => void
}) {
    await forEachLine({
        filePath: csvFile,
        onLine: line => cb(ericParse(line)),
    })
}

// Cross-file j2d through a header file looks like this:
//
// ref,defloc,"five.h:2:4",loc,"main.cpp:13:2",locend,"main.cpp:13:6",kind,"function",name,"five",qualname,"five(int)"
// decldef,name,"five",qualname,"five(int)",loc,"five.h:2:4",locend,"five.h:2:8",defloc,"five.cpp:3:4",kind,"function"
//
// Trimming that down to what's relevant:
//
// ref,defloc,"five.h:2:4",loc,"main.cpp:13:2"
// decldef,loc,"five.h:2:4",defloc,"five.cpp:3:4"
//
// So there's a foreign key constraint between ref.defloc and decldef.loc

function mkDispatch(link: Link): (entry: GenericEntry) => void {
    const dispatchByKind: Record<'ref' | 'decldef', (entry: GenericEntry) => void> = {
        ref: entry => {
            const location = parseLocation(entry.value.loc, entry.value.locend)
            const defloc = parseFilePosition(entry.value.defloc)
            link({
                def: {
                    uri: defloc.uri,
                    // Using the same position for start/end is wrong
                    // Need to fill in the right `end` when we scan an entry with the same `start`
                    range: { start: defloc.position, end: defloc.position },
                },
                ref: location,
            })
        },
        decldef: entry => {
            // console.error('decldef', entry)
        },
    }

    return entry => {
        const dispatch: ((entry: GenericEntry) => void) | undefined =
            dispatchByKind[entry.kind]
        if (!dispatch) {
            // console.log('skipping', line)
            return
        }
        dispatch(entry)
        // TODO handle nuances with merging `decldef`s and composing refs
        // console.log(util.inspect(entry, { depth: 5, colors: true }))
    }
}

function emit<T extends Edge | Vertex>(t: T): void {
    console.log(JSON.stringify(t))
}

function emitRange(loc: lsp.Location) {
    emit<Range>({
        id: stringifyLocation(loc),
        type: ElementTypes.vertex,
        label: VertexLabels.range,
        ...loc.range,
    })
}

function emitDefsRefs({
    refsByDef,
    locByRange,
}: {
    refsByDef: Map<string, Set<string>>
    locByRange: Map<string, lsp.Location>
}): void {
    refsByDef.forEach((refs, def) => {
        const defLoc = locByRange.get(def)
        if (!defLoc) {
            throw new Error('Unable to look up def')
        }

        emit<ResultSet>({
            id: 'resultSet:' + def,
            label: VertexLabels.resultSet,
            type: ElementTypes.vertex,
        })

        emit<next>({
            id: 'next:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.next,
            outV: def,
            inV: 'resultSet:' + def,
        })

        emit<DefinitionResult>({
            id: 'definition:' + def,
            label: VertexLabels.definitionResult,
            type: ElementTypes.vertex,
        })

        emit<textDocument_definition>({
            id: 'textDocument/definition:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_definition,
            outV: 'resultSet:' + def,
            inV: 'definition:' + def,
        })

        emit<item>({
            id: 'item:textDocument/definition:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.item,
            outV: 'definition:' + def,
            inVs: [def],
            document: 'document:' + defLoc.uri,
        })

        emit<ReferenceResult>({
            id: 'reference:' + def,
            label: VertexLabels.referenceResult,
            type: ElementTypes.vertex,
        })

        emit<textDocument_references>({
            id: 'textDocument/references:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_references,
            outV: 'resultSet:' + def,
            inV: 'reference:' + def,
        })

        emit<item>({
            id: 'item:textDocument/references:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.item,
            outV: 'reference:' + def,
            inVs: [def],
            property: ItemEdgeProperties.definitions,
            document: 'document:' + defLoc.uri,
        })

        refs.forEach(ref => {
            emit<next>({
                id: 'next:' + ref,
                type: ElementTypes.edge,
                label: EdgeLabels.next,
                outV: ref,
                inV: 'resultSet:' + def,
            })
        })

        emit<item>({
            id: 'item:textDocument/references:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.item,
            outV: 'reference:' + def,
            inVs: Array.from(refs),
            property: ItemEdgeProperties.references,
            document: 'document:' + defLoc.uri,
        })
    })
}

function emitDocsEnd({
    docs,
    rangesByDoc,
}: {
    docs: Set<string>
    rangesByDoc: Map<string, Set<string>>
}) {
    docs.forEach(doc => {
        const ranges = rangesByDoc.get(doc)
        if (ranges === undefined) {
            throw new Error(
                `rangesByDoc didn't contain doc ${doc}, but contained ${rangesByDoc.keys()}`
            )
        }

        emit<contains>({
            id: 'contains:' + doc,
            type: ElementTypes.edge,
            label: EdgeLabels.contains,
            outV: 'document:' + doc,
            inVs: Array.from(ranges.keys()),
        })

        emit<DocumentEvent>({
            id: 'documentEnd:' + doc,
            data: doc,
            type: ElementTypes.vertex,
            label: VertexLabels.event,
            kind: EventKind.end,
            scope: EventScope.document,
        })
    })
}

function emitDocsBegin({
    projectRoot,
    doc,
}: {
    projectRoot: string
    doc: string
}) {
    emit<Document>({
        id: 'document:' + doc,
        type: ElementTypes.vertex,
        label: VertexLabels.document,
        uri: 'file://' + projectRoot + '/' + doc,
        languageId: 'cpp',
        contents: fs.readFileSync(projectRoot + '/' + doc).toString('base64'),
    })
    emit<DocumentEvent>({
        id: 'documentBegin:' + doc,
        data: doc,
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.begin,
        scope: EventScope.document,
    })
}

function emitProjectEnd() {
    emit<ProjectEvent>({
        id: 'projectEnd',
        data: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.end,
        scope: EventScope.project,
    })
}

function emitProjectBegin() {
    emit<ProjectEvent>({
        id: 'projectBegin',
        data: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.begin,
        scope: EventScope.project,
    })
}

function emitProject() {
    emit<Project>({
        id: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.project,
        kind: 'cpp',
    })
}

function emitMeta(projectRoot: string, csvFileGlob: string) {
    emit<MetaData>({
        id: 'meta',
        type: ElementTypes.vertex,
        label: VertexLabels.metaData,
        projectRoot: 'file://' + projectRoot,
        version: '0.4.0',
        positionEncoding: 'utf-16',
        toolInfo: {
            name: 'lsif-cpp',
            args: [csvFileGlob, projectRoot],
            version: 'dev',
        },
    })
}

function forEachLine({
    filePath,
    onLine,
}: {
    filePath: string
    onLine: (line: string) => void
}): Promise<void> {
    return new Promise((resolve, reject) => {
        let lineNumber = 0
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath),
        })
        rl.on('line', line => {
            try {
                onLine(line)
            } catch (e) {
                reject(
                    new VError(
                        {
                            cause: e,
                            info: { line, lineNumber, filePath },
                        },
                        'while reading a line'
                    )
                )
            }
            lineNumber++
        })
        rl.on('close', resolve)
    })
}

function parseLocation(start: string, end: string): lsp.Location {
    const startP = parseFilePosition(start)
    const endP = parseFilePosition(end)
    if (startP.uri !== endP.uri) {
        throw new Error(
            `expected start and end of range to be in the same file, but were ${start} and ${end}`
        )
    }
    return {
        uri: startP.uri,
        range: {
            start: startP.position,
            end: endP.position,
        },
    }
}

function parseFilePosition(value: string): FilePosition {
    const components = value.split(':')
    if (components.length < 3) {
        throw new Error(
            `expected path of the form path/to/file.cpp:<line>:<column>, got ${value}`
        )
    }
    // Oddly enough, line is base 1 but column is base 0.
    // https://github.com/mozilla/dxr/blob/a4a20cc4a9991a3efbc13cb5fe036f3608368e6c/dxr/plugins/clang/dxr-index.cpp#L285-L287
    const lineBase1 = parseInt(components[components.length - 2], 10)
    const characterBase0 = parseInt(components[components.length - 1], 10)
    const path = components.slice(0, components.length - 2).join('')
    return {
        uri: path,
        position: { line: lineBase1 - 1, character: characterBase0 },
    }
}

// Reimplementation of ericParse with nice error messages, but 5x slower.
function parsimmonParse(line: string): GenericEntry {
    const wordP = P.regexp(/[a-zA-Z_]+/)
    const kindP = wordP
    const keyP = wordP
    const valueP = P.regexp(/"((?:\\.|.)*?)"/, 1).map(value =>
        value.replace('\\', '')
    )
    const commaP = P.string(',')
    const kvP = P.seq(keyP.skip(commaP), valueP)
    const lineP = P.seq(kindP.skip(commaP), P.sepBy(kvP, commaP)).map(
        ([kind, kvs]) => ({ kind, value: fromPairs(kvs) })
    )

    return lineP.tryParse(line)
}

function ericParse(line: string): GenericEntry {
    function fields(line: string): string[] {
        let i = 0
        const fields: any[] = []

        const eatWhitespace = () => {
            while (i < line.length && line[i] == ' ') {
                i++
            }
        }

        const eatSeparator = () => {
            if (i < line.length && line[i] == ',') {
                i++
                return
            }

            throw new Error(`expected comma`)
        }

        const parseIdent = () => {
            const start = i
            i++
            while (i < line.length && isIdent(line[i])) {
                i++
            }

            fields.push(line.substring(start, i))
        }

        const parseString = () => {
            i++
            const start = i

            while (i < line.length) {
                if (line[i] == '"') {
                    fields.push(line.substring(start, i))
                    i++
                    return
                }

                if (line[i] == '\\') {
                    if (i + 1 >= line.length) {
                        throw new Error(`unterminated escape sequence`)
                    }

                    i++
                }

                i++
            }

            throw new Error(`unterminated string`)
        }

        while (i < line.length) {
            eatWhitespace()

            if (i > 0) {
                eatSeparator()
                eatWhitespace()
            }

            if (isIdent(line[i])) {
                parseIdent()
            } else if (line[i] == '"') {
                parseString()
            } else {
                console.log(fields)
                throw new Error(`unknown start of token ${line[i]}`)
            }

            eatWhitespace()
        }

        return fields
    }

    function isIdent(char: string): boolean {
        if (char === '_') {
            return true
        }

        if ('a' <= char && char <= 'z') {
            return true
        }

        if ('A' <= char && char <= 'Z') {
            return true
        }

        return false
    }

    const parts = fields(line)
    if (parts.length === 0) {
        throw new Error('expected at least one field')
    }

    return {
        kind: parts[0],
        value: fromPairs(chunk(parts.slice(1), 2)),
    }
}

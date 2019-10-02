import * as readline from 'readline'
import * as fs from 'fs'
import * as util from 'util'
import * as path from 'path'
import { VError } from 'verror'
import * as sourceMapSupport from 'source-map-support'
sourceMapSupport.install()
import {
    fromPairs,
    chunk,
    Dictionary,
    isEqual,
    difference,
    groupBy,
    map as mapObject,
    map,
    forEach,
    toPairs,
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
    MonikerKind,
    moniker,
    packageInformation,
} from 'lsif-protocol'
import * as lsp from 'vscode-languageserver-protocol'
import * as P from 'parsimmon'
import glob from 'glob'

// What are all of the kinds? According to DXR source code:
//
// rg "^\s*beginRecord" dxr/plugins/clang/dxr-index.cpp | gsed "s/^ *beginRecord..\(\w\+\).*/\1/" | sort
//
// call call decldef func_override function impl include macro namespace namespace_alias ref ref type typedef typedef variable warning
//
// TODO exhaustiveness check: make sure all kinds and fields are used (or at least acknowledged) by this converter.

type Emit = <T extends Edge | Vertex>(item: T) => Promise<void>

export async function index({
    csvFileGlob,
    root,
    emit,
}: {
    csvFileGlob: string
    root: string
    emit: Emit
}): Promise<void> {
    await emit(makeMeta(root, csvFileGlob))
    await emit(makeProject())
    await emit(makeProjectBegin())

    const docs = new Set<string>()
    const rangesByDoc = new Map<string, Set<string>>()
    const refsByDef = new Map<string, Set<string>>()
    const locByRange = new Map<string, lsp.Location>()
    const importMonikerByRange = new Map<
        string,
        { moniker: string; packageInformation: string }
    >()
    const exportMonikerByRange = new Map<
        string,
        { moniker: string; packageInformation: string }
    >()

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

    function recordMoniker({
        moniker,
        range,
        kind,
        packageInformation,
    }: {
        moniker: string
        range: string
        kind: MonikerKind
        packageInformation: string
    }): void {
        switch (kind) {
            case MonikerKind.import:
                importMonikerByRange.set(range, { moniker, packageInformation })
                break
            case MonikerKind.export:
                exportMonikerByRange.set(range, { moniker, packageInformation })
                break
            default:
                console.log('unimplemented kind', kind)
        }
    }

    const dp = mkDispatch({ link, recordMoniker })
    const csvFiles = glob.sync(csvFileGlob)
    if (csvFiles.length === 0) {
        throw new Error(`glob ${csvFileGlob} did not match any files`)
    }
    for (const csvFile of csvFiles) {
        await scanCsvFile({ csvFile, cb: dp })
    }

    for (const doc of Array.from(docs)) {
        await emitDocsBegin({ root, doc, emit })
    }

    for (const range of Array.from(locByRange.keys())) {
        const loc = locByRange.get(range)
        if (!loc) {
            throw new Error(
                `Unable to look up loc by range ${range} ${util.inspect(
                    locByRange
                )}`
            )
        }
        await emit(makeRange(loc))
    }

    followTransitiveDefsDepth1(refsByDef)

    await emitDefsRefs({
        refsByDef,
        locByRange,
        emit,
        importMonikerByRange,
        exportMonikerByRange,
    })

    await emitDocsEnd({ docs, rangesByDoc, emit })

    await emit<contains>({
        id: 'projectContains',
        type: ElementTypes.edge,
        label: EdgeLabels.contains,
        outV: 'project',
        inVs: Array.from(docs).map(doc => 'document:' + doc),
    })

    await emit(makeProjectEnd())
}

function stringifyLocation(loc: lsp.Location): string {
    return `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`
}

interface FilePosition {
    uri: string
    position: lsp.Position
}

type GenericEntry = { kind: string; value: Dictionary<string> }

type Link = (info: { def: lsp.Location; ref: lsp.Location }) => void

type RecordMoniker = (arg: {
    moniker: string
    range: string
    kind: MonikerKind
    packageInformation: string
}) => void

async function scanCsvFile({
    csvFile,
    cb,
}: {
    csvFile: string
    cb: (genericEntry: GenericEntry) => void
}) {
    let chunk = ''
    await forEachLine({
        filePath: csvFile,
        onLine: line => {
            if (line.endsWith('\\')) {
                chunk += line.replace(/\\$/, '').replace(/""/g, '\\"')
            } else {
                chunk += line
                cb(ericParse(chunk))
                chunk = ''
            }
        },
    })
}

// mutates arg
function followTransitiveDefsDepth1(refsByDef: Map<string, Set<string>>): void {
    for (const [def, refs] of Array.from(refsByDef.entries())) {
        for (const ref of Array.from(refs)) {
            const transitiveRefs: Set<string> | undefined = refsByDef.get(ref)
            if (!transitiveRefs) {
                continue
            }
            transitiveRefs.forEach(tref => refs.add(tref))
            if (!Array.from(transitiveRefs).some(tref => tref === ref)) {
                refsByDef.delete(ref)
            }
        }
    }
}

// Cross-file j2d through a header file looks like this:
//
// ref,defloc,"five.h:2:4",deflocend,"five.h:2:8",loc,"main.cpp:13:2",locend,"main.cpp:13:6",kind,"function",name,"five",qualname,"five(int)"
// decldef,name,"five",qualname,"five(int)",loc,"five.h:2:4",locend,"five.h:2:8",defloc,"five.cpp:3:4",kind,"function"
//
// Trimming that down to what's relevant:
//
// ref,defloc,"five.h:2:4",loc,"main.cpp:13:2"
// decldef,loc,"five.h:2:4",defloc,"five.cpp:3:4"
//
// So there's a foreign key constraint between ref.defloc and decldef.loc

function mkDispatch({
    link,
    recordMoniker,
}: {
    link: Link
    recordMoniker: RecordMoniker
}): (entry: GenericEntry) => void {
    const dispatchByKind: Record<
        'ref' | 'decldef',
        (entry: GenericEntry) => void
    > = {
        ref: entry => {
            const location = parseLocation(entry.value.loc, entry.value.locend)
            if (!entry.value.defloc) {
                link({
                    def: location,
                    ref: location,
                })
                recordMoniker({
                    moniker: entry.value.qualname,
                    range: stringifyLocation(location),
                    kind: MonikerKind.import,
                    packageInformation: 'lol',
                })
                return
            }
            link({
                def: parseLocation(entry.value.defloc, entry.value.defloc),
                ref: location,
            })
        },
        decldef: entry => {
            const location = parseLocation(entry.value.loc, entry.value.locend)
            if (!entry.value.defloc) {
                recordMoniker({
                    moniker: entry.value.qualname,
                    range: stringifyLocation(location),
                    kind: MonikerKind.import,
                    packageInformation: 'lol',
                })
                return
            }
            const defLocation = parseLocation(
                entry.value.defloc,
                entry.value.deflocend
            )
            recordMoniker({
                moniker: entry.value.qualname,
                range: stringifyLocation(defLocation),
                kind: MonikerKind.export,
                packageInformation: 'lol',
            })
            link({
                def: defLocation,
                ref: location,
            })
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

function makeRange(loc: lsp.Location): Range {
    return {
        id: stringifyLocation(loc),
        type: ElementTypes.vertex,
        label: VertexLabels.range,
        ...loc.range,
    }
}

async function emitDefsRefs({
    refsByDef,
    locByRange,
    emit,
    importMonikerByRange,
    exportMonikerByRange,
}: {
    refsByDef: Map<string, Set<string>>
    locByRange: Map<string, lsp.Location>
    emit: Emit
    importMonikerByRange: Map<
        string,
        { moniker: string; packageInformation: string }
    >
    exportMonikerByRange: Map<
        string,
        { moniker: string; packageInformation: string }
    >
}): Promise<void> {
    for (const [def, refs] of Array.from(refsByDef.entries())) {
        const defLoc = locByRange.get(def)
        if (!defLoc) {
            throw new Error('Unable to look up def')
        }

        //  ---14*packageEdge:$package---> (13*packageEdge:$package)
        // |
        // (11*moniker:export:$id) <---12*monikerEdge:export:$def
        //                                            \
        //                                            |
        //  ---2.3*packageEdge:$package---> (2.4*packageEdge:$package)
        // |                                          |
        // (2.2*moniker:import:$id) <---2.1*monikerEdge:import:$def
        //                                          \ |  ------------------------------------------------------------------
        //                                           \|/                                                                    \
        // ($def) ---2*next:$def---> 1*(resultSet:$def) ---7*textDocument/references:$def---> 6*(reference:$def) -------     \
        //  | |                                        \---4*textDocument/definition:$def---> 3*(definition:$def)   \    \    |
        //   \ \                                                                             /                       |    |   |
        //    \  ---<---5*item:textDocument/definition:$def---------------------------------                        /     |   |
        //      ----<---8*item:textDocument/references:definitions:$def--------------------------------------------      /    |
        //          ----------------<---10*item:textDocument/references:references:$def:$*uri---------------------------     /
        //        /-------/-------------------9*next:$*ref--->--------------------------------------------------------------
        //       /       /
        // ($ref1) ($ref2) ...

        // 1
        await emit<ResultSet>({
            id: 'resultSet:' + def,
            label: VertexLabels.resultSet,
            type: ElementTypes.vertex,
        })

        // 2
        await emit<next>({
            id: 'next:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.next,
            outV: def,
            inV: 'resultSet:' + def,
        })

        const importMoniker = importMonikerByRange.get(def)
        if (importMoniker) {
            // 2.1
            await emit<Moniker>({
                id: 'moniker:import:' + def,
                label: VertexLabels.moniker,
                type: ElementTypes.vertex,
                identifier: importMoniker.moniker,
                kind: MonikerKind.import,
                scheme: 'cpp',
            })
            // 2.2
            await emit<moniker>({
                id: 'monikerEdge:import:' + def,
                label: EdgeLabels.moniker,
                type: ElementTypes.edge,
                inV: 'moniker:import:' + def,
                outV: 'resultSet:' + def,
            })
            // 2.3
            await emit<PackageInformation>({
                id: 'package:' + importMoniker.packageInformation,
                label: VertexLabels.packageInformation,
                type: ElementTypes.vertex,
                manager: 'cpp',
                name: importMoniker.packageInformation,
                version: '1.0',
            })
            // 2.4
            await emit<packageInformation>({
                id: 'packageEdge:' + importMoniker.packageInformation,
                label: EdgeLabels.packageInformation,
                type: ElementTypes.edge,
                inV: 'package:' + importMoniker.packageInformation,
                outV: 'moniker:import:' + def,
            })
        } else {
            // 3
            await emit<DefinitionResult>({
                id: 'definition:' + def,
                label: VertexLabels.definitionResult,
                type: ElementTypes.vertex,
            })

            // 4
            await emit<textDocument_definition>({
                id: 'textDocument/definition:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.textDocument_definition,
                outV: 'resultSet:' + def,
                inV: 'definition:' + def,
            })

            // 5
            await emit<item>({
                id: 'item:textDocument/definition:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: 'definition:' + def,
                inVs: [def],
                document: 'document:' + defLoc.uri,
            })
        }

        // 6
        await emit<ReferenceResult>({
            id: 'reference:' + def,
            label: VertexLabels.referenceResult,
            type: ElementTypes.vertex,
        })

        // 7
        await emit<textDocument_references>({
            id: 'textDocument/references:' + def,
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_references,
            outV: 'resultSet:' + def,
            inV: 'reference:' + def,
        })

        if (!importMoniker) {
            // 8
            await emit<item>({
                id: 'item:textDocument/references:definitions:' + def,
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: 'reference:' + def,
                inVs: [def],
                property: ItemEdgeProperties.definitions,
                document: 'document:' + defLoc.uri,
            })
        }

        // 9
        for (const ref of Array.from(refs)) {
            await emit<next>({
                id: 'next:' + ref,
                type: ElementTypes.edge,
                label: EdgeLabels.next,
                outV: ref,
                inV: 'resultSet:' + def,
            })
        }

        // 10
        for (const [uri, refsForCurrentUri] of toPairs(
            groupBy(Array.from(refs), ref => parseFilePosition(ref).uri)
        )) {
            await emit<item>({
                id:
                    'item:textDocument/references:references:' +
                    def +
                    ':' +
                    uri,
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: 'reference:' + def,
                inVs: Array.from(refsForCurrentUri),
                property: ItemEdgeProperties.references,
                document: 'document:' + uri,
            })
        }

        const exportMoniker = exportMonikerByRange.get(def)
        if (exportMoniker) {
            // 11
            await emit<Moniker>({
                id: 'moniker:export:' + def,
                label: VertexLabels.moniker,
                type: ElementTypes.vertex,
                identifier: exportMoniker.moniker,
                kind: MonikerKind.export,
                scheme: 'cpp',
            })
            // 12
            await emit<moniker>({
                id: 'monikerEdge:export:' + def,
                label: EdgeLabels.moniker,
                type: ElementTypes.edge,
                inV: 'moniker:export:' + def,
                outV: 'resultSet:' + def,
            })
            // 13
            await emit<PackageInformation>({
                id: 'package:' + exportMoniker.packageInformation,
                label: VertexLabels.packageInformation,
                type: ElementTypes.vertex,
                manager: 'cpp',
                name: exportMoniker.packageInformation,
                version: '1.0',
            })
            // 14
            await emit<packageInformation>({
                id: 'packageEdge:' + exportMoniker.packageInformation,
                label: EdgeLabels.packageInformation,
                type: ElementTypes.edge,
                inV: 'package:' + exportMoniker.packageInformation,
                outV: 'moniker:export:' + def,
            })
        }
    }
}

async function emitDocsEnd({
    docs,
    rangesByDoc,
    emit,
}: {
    docs: Set<string>
    rangesByDoc: Map<string, Set<string>>
    emit: Emit
}): Promise<void> {
    for (const doc of Array.from(docs)) {
        const ranges = rangesByDoc.get(doc)
        if (ranges === undefined) {
            throw new Error(
                `rangesByDoc didn't contain doc ${doc}, but contained ${rangesByDoc.keys()}`
            )
        }

        await emit<contains>({
            id: 'contains:' + doc,
            type: ElementTypes.edge,
            label: EdgeLabels.contains,
            outV: 'document:' + doc,
            inVs: Array.from(ranges.keys()),
        })

        await emit<DocumentEvent>({
            id: 'documentEnd:' + doc,
            data: 'document:' + doc,
            type: ElementTypes.vertex,
            label: VertexLabels.event,
            kind: EventKind.end,
            scope: EventScope.document,
        })
    }
}

async function emitDocsBegin({
    root,
    doc,
    emit,
}: {
    root: string
    doc: string
    emit: Emit
}): Promise<void> {
    let contents = ''
    try {
        contents = fs.readFileSync(path.join(root, doc)).toString('base64')
    } catch (e) {
        // ignore
    }
    await emit<Document>({
        id: 'document:' + doc,
        type: ElementTypes.vertex,
        label: VertexLabels.document,
        uri: 'file:///' + doc,
        languageId: 'cpp',
        contents,
    })
    await emit<DocumentEvent>({
        id: 'documentBegin:' + doc,
        data: 'document:' + doc,
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.begin,
        scope: EventScope.document,
    })
}

function makeProjectEnd(): ProjectEvent {
    return {
        id: 'projectEnd',
        data: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.end,
        scope: EventScope.project,
    }
}

function makeProjectBegin(): ProjectEvent {
    return {
        id: 'projectBegin',
        data: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.event,
        kind: EventKind.begin,
        scope: EventScope.project,
    }
}

function makeProject(): Project {
    return {
        id: 'project',
        type: ElementTypes.vertex,
        label: VertexLabels.project,
        kind: 'cpp',
    }
}

function makeMeta(root: string, csvFileGlob: string): MetaData {
    return {
        id: 'meta',
        type: ElementTypes.vertex,
        label: VertexLabels.metaData,
        projectRoot: 'file:///',
        version: '0.4.0',
        positionEncoding: 'utf-16',
        toolInfo: {
            name: 'lsif-cpp',
            args: [csvFileGlob, root],
            version: 'dev',
        },
    }
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
                            info: { lineNumber, filePath },
                        },
                        'error'
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

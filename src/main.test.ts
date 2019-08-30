import { index } from './index'
import { Edge, Vertex } from 'lsif-protocol'
import _ from 'lodash'
import * as path from 'path'
import * as cp from 'child_process'

async function generateAndIndex(example: string): Promise<(Edge | Vertex)[]> {
    const output: (Edge | Vertex)[] = []

    cp.execFileSync('./generate-csv', ['$CXX -c *.cpp'], {
        env: {
            ABSROOTDIR: path.resolve(`examples/${example}/root`),
            ABSOUTDIR: path.resolve(`examples/${example}/output`),
            CLEAN: 'true',
        },
    })

    await index({
        csvFileGlob: `examples/${example}/output/*.csv`,
        root: `examples/${example}/root`,
        emit: item =>
            new Promise(resolve => {
                output.push(item)
                resolve()
            }),
    })

    return output
}

test('does not emit items with duplicate IDs', async () => {
    const output = await generateAndIndex('five')

    const setsOfDupes = _(output)
        .groupBy(item => item.id)
        .values()
        .map(group => ({ group, count: group.length }))
        .value()
        .filter(({ count }) => count > 1)
        .map(({ group }) => group)

    if (setsOfDupes.length > 0) {
        fail(
            new Error(
                `Sets of lines with duplicate IDs:\n` +
                    setsOfDupes
                        .map(dupes =>
                            dupes.map(item => JSON.stringify(item)).join('\n')
                        )
                        .join('\n\n')
            )
        )
    }
})

test('output', async () => {
    const output = (await generateAndIndex('five')).map(v => JSON.stringify(v))

    expect(output.join('\n')).toMatchSnapshot()
})

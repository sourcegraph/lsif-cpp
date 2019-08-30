import { index } from './index'
import { Edge, Vertex } from 'lsif-protocol'
import _ from 'lodash'

test('does not emit items with duplicate IDs', async () => {
    const output: (Edge | Vertex)[] = []

    await index({
        csvFileGlob: '/Users/chrismwendt/github.com/mozilla/dxr/example/*.csv',
        projectRoot: '/Users/chrismwendt/github.com/mozilla/dxr/example',
        emit: item =>
            new Promise(resolve => {
                output.push(item)
                resolve()
            }),
    })

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

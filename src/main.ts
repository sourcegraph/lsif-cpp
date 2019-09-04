import { index } from './index'
import * as yargs from 'yargs'
import * as fs from 'fs'

// Causes node to print all stacks from nested VErrors.
process.on('uncaughtException', error => {
    console.log(error)
    process.exit(1)
})

// tslint:disable:no-floating-promises
main()

async function main() {
    const { csvFileGlob, root, out } = yargs
        .demandOption('csvFileGlob')
        .demandOption('out')
        .demandOption('root').argv as {
        csvFileGlob: string
        root: string
        out: string
    }

    try {
        fs.unlinkSync(out)
    } catch (e) {
        // yolo
    }

    await index({
        csvFileGlob,
        root,
        emit: item =>
            new Promise(resolve => {
                fs.appendFileSync(out, JSON.stringify(item) + '\n')
                resolve()
            }),
    })
}

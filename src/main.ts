import { index } from './index'

// Causes node to print all stacks from nested VErrors.
process.on('uncaughtException', error => {
    console.log(error)
    process.exit(1)
})

// tslint:disable:no-floating-promises
main()

async function main() {
    await index({
        csvFileGlob: '/Users/chrismwendt/github.com/mozilla/dxr/example/*.csv',
        projectRoot: '/Users/chrismwendt/github.com/mozilla/dxr/example',
        emit: item =>
            new Promise(resolve => {
                console.log(JSON.stringify(item))
                resolve()
            }),
    })
}

import { fileURLToPath } from 'node:url'
import { lintContent } from './lint.js'

const CONTENT_DIR = fileURLToPath(new URL('../../../content', import.meta.url))
const USAGE = 'usage: cli.ts <sync [--check] | check:facts | check:links>'

async function main(argv: string[]): Promise<number> {
  const [command] = argv
  switch (command) {
    case 'check:facts': {
      const { errors } = await lintContent(CONTENT_DIR)
      for (const error of errors) console.error(error)
      if (errors.length) {
        console.error(`content lint: ${errors.length} error(s)`)
        return 1
      }
      console.log('content lint: ok')
      return 0
    }
    case 'sync':
    case 'check:links':
      console.error(`${command}: not implemented`)
      return 2
    default:
      console.error(USAGE)
      return 2
  }
}

process.exitCode = await main(process.argv.slice(2))

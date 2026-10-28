import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { lintContent, staleVerified } from './lint.js'
import { renderAll, writeOrCheck } from './render.js'
import { checkLinks } from './links.js'

// Paths are repo-relative; main() runs from the repo root so printed paths are too.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CONTENT_DIR = 'content'
const MCP_OUT = 'packages/mcp/content'
const SKILL_REFS_OUT = 'packages/skill/skills/bsv-dev/references'
const SKILL_DIR = 'packages/skill/skills'
// Each sample's README only: the rest of a sample (node_modules, build output) is not link-checked.
const SAMPLE_READMES = 'samples/*/README.md'
const USAGE = 'usage: cli.ts <sync [--check] | check:facts [--max-age-days N] | check:links>'

/**
 * Reads `--name N` or `--name=N` as a non-negative integer. Returns undefined when the flag is absent and
 * null when it is present without a valid value (the caller prints usage).
 */
function intOption(argv: string[], name: string): number | undefined | null {
  let raw: string | undefined
  let present = false
  argv.forEach((arg, i) => {
    if (arg === name) {
      present = true
      raw = argv[i + 1]
    } else if (arg.startsWith(`${name}=`)) {
      present = true
      raw = arg.slice(name.length + 1)
    }
  })
  if (!present) return undefined
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null
}

async function sync(check: boolean): Promise<number> {
  const { version } = JSON.parse(await readFile('packages/mcp/package.json', 'utf8')) as { version: string }
  const files = await renderAll({ contentDir: CONTENT_DIR, mcpOut: MCP_OUT, skillRefsOut: SKILL_REFS_OUT, version })
  // packages/mcp/content is wholly generated; the skill's references dir also holds authored files.
  const differing = await writeOrCheck(files, check, [MCP_OUT])
  for (const path of differing) console.log(path)
  if (check) {
    if (differing.length) {
      console.error(`sync --check: ${differing.length} file(s) out of date; run pnpm sync`)
      return 1
    }
    console.log('sync --check: up to date')
    return 0
  }
  console.log(`sync: ${differing.length} file(s) changed`)
  return 0
}

async function checkFacts(argv: string[]): Promise<number> {
  const maxAge = intOption(argv, '--max-age-days')
  if (maxAge === null) {
    console.error(USAGE)
    return 2
  }
  const { errors } = await lintContent(CONTENT_DIR)
  for (const error of errors) console.error(error)
  const stale = maxAge === undefined ? [] : await staleVerified(CONTENT_DIR, maxAge)
  for (const line of stale) console.error(line)
  if (errors.length || stale.length) {
    console.error(`content lint: ${errors.length} error(s), ${stale.length} stale date(s)`)
    return 1
  }
  console.log(maxAge === undefined ? 'content lint: ok' : `content lint: ok (verified dates within ${maxAge} days)`)
  return 0
}

async function links(): Promise<number> {
  const { broken } = await checkLinks(CONTENT_DIR, [SKILL_DIR], [SAMPLE_READMES])
  for (const b of broken) console.error(`${b.file}: ${b.url} (${b.status === 0 ? 'no answer' : b.status < 400 ? `${b.status}, Page Not Found body` : b.status})`)
  if (broken.length) {
    console.error(`check:links: ${broken.length} broken`)
    return 1
  }
  console.log('check:links: ok')
  return 0
}

async function main(argv: string[]): Promise<number> {
  process.chdir(REPO_ROOT)
  const [command] = argv
  switch (command) {
    case 'sync':
      return sync(argv.includes('--check'))
    case 'check:facts':
      return checkFacts(argv)
    case 'check:links':
      return links()
    default:
      console.error(USAGE)
      return 2
  }
}

process.exitCode = await main(process.argv.slice(2))

#!/usr/bin/env node
// node packages/mcp/build/cli/versions-check.js [--json] [--max-age-days N] (repo maintainers; not an installed bin)
// Prints the versions_check rows (Markdown table, or JSON with --json). Exits 1 when any row drifts or any
// verified date is older than N days (default 60), 2 on bad arguments.
import { formatVersionsTable, loadVersionsFile, versionsCheck } from '../tools/versions.js'

const USAGE = 'usage: node packages/mcp/build/cli/versions-check.js [--json] [--max-age-days N]'

function parseArgs(argv: string[]): { json: boolean; maxAgeDays: number } {
  let json = false
  let maxAgeDays = 60
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--max-age-days' || arg.startsWith('--max-age-days=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      // A malformed value must not silently disable the age gate.
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`--max-age-days needs a whole number of days, got ${value ?? 'nothing'}`)
      maxAgeDays = Number(value)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return { json, maxAgeDays }
}

async function main(): Promise<number> {
  let args: { json: boolean; maxAgeDays: number }
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`)
    return 2
  }
  const report = await versionsCheck(loadVersionsFile(), globalThis.fetch)
  console.log(args.json ? JSON.stringify(report, null, 2) : formatVersionsTable(report))
  const drifted = report.rows.filter((r) => r.drift).map((r) => r.name)
  // NaN (an unreadable verified date) counts as stale.
  const stale = report.rows.filter((r) => !(r.ageDays <= args.maxAgeDays)).map((r) => r.name)
  if (drifted.length) console.error(`drift: ${drifted.join(', ')}`)
  if (stale.length) console.error(`verified more than ${args.maxAgeDays} days ago: ${stale.join(', ')}`)
  return drifted.length || stale.length ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  },
)

#!/usr/bin/env node
// node packages/mcp/build/cli/check-guardrails.js <path> (repo maintainers and CI; not an installed bin)
// Runs check_guardrails over the project at <path> (relative paths resolve against the current directory).
// Prints the GuardrailReport JSON on stdout and the human summary on stderr.
// Exits 0 with no `error` finding, 1 on any `error` finding, 2 on a usage error (wrong arguments, path not a directory).
import { resolve } from 'node:path'
import { checkGuardrails } from '../tools/guardrails.js'

const USAGE = 'usage: node packages/mcp/build/cli/check-guardrails.js <path>'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0] === '' || args[0].startsWith('-')) {
    console.error(USAGE)
    return 2
  }
  // The tool requires an absolute path (its cwd is not the user's); this CLI's cwd is, so resolve here.
  const path = resolve(process.cwd(), args[0])
  let result: Awaited<ReturnType<typeof checkGuardrails>>
  try {
    result = await checkGuardrails({ path })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!/^path (not found|is not a directory)/.test(message)) throw e
    console.error(`${message}\n${USAGE}`)
    return 2
  }
  console.log(JSON.stringify(result.report, null, 2))
  console.error(result.summary)
  return result.report.findings.some((f) => f.severity === 'error') ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  },
)

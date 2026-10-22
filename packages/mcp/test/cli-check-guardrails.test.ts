import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../build/cli/check-guardrails.js', import.meta.url))
const PROJECTS = fileURLToPath(new URL('./fixtures/projects/', import.meta.url))

function run(args: string[], cwd = PROJECTS): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr })
    })
  })
}

describe('check-guardrails CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`pnpm -F @bsv/mcp build\` before this test`)
  })

  it('resolves a relative path, prints the report JSON and exits 0 with no error findings', async () => {
    const r = await run(['clean-a'])
    expect(r.code).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.shapeDetected).toBe('A')
    expect(report.findings.filter((f: { severity: string }) => f.severity === 'error')).toEqual([])
    expect(r.stderr).toMatch(/^check_guardrails: 0 errors/)
  })

  it('exits 1 when any finding is an error', async () => {
    const r = await run(['./broken-a'])
    expect(r.code).toBe(1)
    const report = JSON.parse(r.stdout)
    expect(report.findings.some((f: { severity: string }) => f.severity === 'error')).toBe(true)
  })

  it('exits 2 on a usage error', async () => {
    expect((await run([])).code).toBe(2)
    expect((await run(['clean-a', 'broken-a'])).code).toBe(2)
    const missing = await run(['no-such-project'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toMatch(/path not found/)
    expect(missing.stdout).toBe('')
  })
})

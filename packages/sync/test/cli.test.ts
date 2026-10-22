import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
function run(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: pkgDir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

// Accept cases use a 100-year limit: they test argument parsing against the real content and must not
// go red as that content ages (the CLI measures age against the wall clock).
describe('cli check:facts --max-age-days', () => {
  it('accepts the space form', () => {
    const r = run('check:facts', '--max-age-days', '36500')
    expect(r.code).toBe(0)
    expect(r.out).toContain('content lint: ok (verified dates within 36500 days)')
  })
  it('accepts the = form', () => {
    const r = run('check:facts', '--max-age-days=36500')
    expect(r.code).toBe(0)
    expect(r.out).toContain('content lint: ok (verified dates within 36500 days)')
  })
  it.each([
    [['--max-age-days']],
    [['--max-age-days', 'abc']],
    [['--max-age-days', '-5']],
    [['--max-age-days', '6.5']],
    [['--max-age-days=']],
    [['--max-age-days=x']],
  ])('rejects %j with a usage error', (args) => {
    const r = run('check:facts', ...args)
    expect(r.code).toBe(2)
    expect(r.out).toContain('usage:')
  })
})

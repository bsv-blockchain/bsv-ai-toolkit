import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
describe('package', () => {
  it('is @bsv/mcp 2.0.0 with bin bsv-mcp', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.name).toBe('@bsv/mcp')
    expect(pkg.version).toBe('2.0.0')
    expect(pkg.bin['bsv-mcp']).toBe('build/index.js')
    expect(pkg.engines.node).toBe('>=22')
  })
})

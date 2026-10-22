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

  // npx runs a lone bin, else the bin named after the unscoped package name (`mcp`); `npx -y @bsv/mcp` needs the former.
  it('has exactly one bin, bsv-mcp, so npx -y @bsv/mcp resolves it', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.bin).toEqual({ 'bsv-mcp': 'build/index.js' })
  })
})

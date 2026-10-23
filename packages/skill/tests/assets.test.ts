import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGuardrails } from '../../mcp/src/lint/engine.ts'

const assets = fileURLToPath(new URL('../skills/bsv-dev/assets/', import.meta.url))
const installSh = fileURLToPath(new URL('../install.sh', import.meta.url))
const mcpContent = fileURLToPath(new URL('../../mcp/content/', import.meta.url))
const read = (file: string) => readFileSync(join(assets, file), 'utf8')

type Group = {
  spendingAuthorization: { amount: number; description: string }
  protocolPermissions: { protocolID: [number, string]; counterparty?: string; description: string }[]
  basketAccess: { basket: string; description: string }[]
}
type Manifest = { _comment?: string; metanet: { groupPermissions: Group }; babbage: { groupPermissions: Group } }
const manifest = () => JSON.parse(read('manifest.template.json')) as Manifest

/** The rule lines of a snippet: frontmatter, HTML comment markers and blank lines dropped, list prefixes stripped. */
function rules(text: string): string[] {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !(l.startsWith('<!--') && l.endsWith('-->')))
    .map((l) => l.replace(/^(?:- |\d+\. )/, ''))
}

describe('assets', () => {
  it('manifest template has identical metanet and babbage groupPermissions', () => {
    const m = manifest()
    expect(m.metanet.groupPermissions).toBeDefined()
    expect(m.babbage.groupPermissions).toEqual(m.metanet.groupPermissions)
    expect(m._comment).toMatch(/unsettled whether BSV Desktop treats 'self' as grouped/)
  })

  it('manifest has one level-1 protocol and the BRC-29 entry', () => {
    const g = manifest().metanet.groupPermissions
    expect(g.spendingAuthorization.amount).toBe(10000)
    expect(g.protocolPermissions.filter((p) => p.protocolID[0] === 1)).toEqual([
      { protocolID: [1, '__APP_NAME__ actions'], description: 'Sign __APP_NAME__ actions' },
    ])
    expect(g.protocolPermissions.filter((p) => p.protocolID[0] === 2)).toEqual([
      { protocolID: [2, '3241645161d8'], counterparty: 'self', description: 'BRC-29 payments' },
    ])
    expect(g.basketAccess).toEqual([{ basket: '__APP_NAME__', description: '__APP_NAME__ outputs' }])
  })

  it('manifest protocol names are ones the wallet accepts once __APP_NAME__ is filled in', () => {
    const m = manifest()
    expect(m._comment).toContain("__APP_NAME__: lowercase letters, digits and single spaces only (e.g. 'my app')")
    expect(m._comment).toMatch(/may be deleted from the deployed manifest/)
    const filled = JSON.parse(read('manifest.template.json').replaceAll('__APP_NAME__', 'my app')) as Manifest
    const names = filled.metanet.groupPermissions.protocolPermissions.map((p) => p.protocolID[1])
    // @bsv/sdk KeyDeriver.computeInvoiceNumber: 5+ chars of [a-z0-9 ], no double space, no trailing ' protocol'.
    for (const n of names) {
      expect(n).toMatch(/^[a-z0-9 ]+$/)
      expect(n.length).toBeGreaterThanOrEqual(5)
      expect(n).not.toContain('  ')
      expect(n).not.toMatch(/ protocol$/)
    }
  })

  it('a shape-A project using the manifest template passes G-03 and G-04', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsv-assets-'))
    try {
      mkdirSync(join(dir, 'public'))
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'public/manifest.json'), read('manifest.template.json').replaceAll('__APP_NAME__', 'demo'))
      writeFileSync(join(dir, 'src/wallet.ts'), "import { WalletClient } from '@bsv/sdk'\nexport const wallet = new WalletClient('auto', 'demo.example')\n")
      const report = await runGuardrails(dir, { contentDir: mcpContent })
      expect(report.shapeDetected).toBe('A')
      expect(report.findings.filter((f) => f.id === 'G-03' || f.id === 'G-04')).toEqual([])
      expect(report.passed).toEqual(expect.arrayContaining(['G-03', 'G-04']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the three snippets carry the same nine rules', () => {
    const mdc = read('bsv.mdc')
    expect(mdc).toMatch(/^---\ndescription: BSV development rules\nalwaysApply: true\n---\n/)
    for (const file of ['CLAUDE.md.snippet', 'AGENTS.md.snippet']) {
      expect(read(file), file).toMatch(/^<!-- bsv-dev rules: begin -->\n[\s\S]*\n<!-- bsv-dev rules: end -->\n$/)
    }
    const claude = rules(read('CLAUDE.md.snippet'))
    expect(claude).toHaveLength(9)
    expect(rules(read('AGENTS.md.snippet'))).toEqual(claude)
    expect(rules(mdc)).toEqual(claude)
    expect(claude[0]).toContain('https://bsv.writedocs.io/llms.txt')
    expect(claude[0]).toContain('open the same path on bsv.writedocs.io instead')
    expect(claude[1]).toMatch(/^When the `bsv-docs` and `bsv-mcp` MCP servers are connected, /)
    expect(claude[2]).toContain('check that `wallet.getNetwork()` returns `testnet`')
    expect(claude[3]).toMatch(/^For the user's wallet, .*from the browser or a local script\.$/)
    expect(claude[4]).toMatch(/shape A.*shape B/)
    expect(claude[5]).toMatch(/https:\/\/bsvfaucet\.com.*never work around either/)
    expect(claude[6]).toContain('never the legacy ARC API')
    expect(claude[7]).toMatch(/SEEN_ON_NETWORK.*never/)
    expect(claude[8]).toMatch(/^If `bsv-mcp` is connected, run `check_guardrails`.*absolute/)
  })

  it('env.example has no key variables', () => {
    const lines = read('env.example').split('\n')
    for (const l of lines) if (l !== 'WOC_API_KEY=') expect(l).not.toMatch(/KEY=|WIF|MNEMONIC|SECRET/)
    for (const v of ['BSV_NETWORK=testnet', 'ARCADE_URL=', 'WOC_API_KEY=', 'PUBLIC_ORIGIN=http://localhost:5173', 'FEE_SAT_PER_KB=100']) {
      expect(lines).toContain(v)
    }
  })

  it('install-commands.md has the four install strings', () => {
    const t = read('install-commands.md')
    for (const s of [
      'npx skills add bsv-blockchain/bsv-ai-toolkit',
      'claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv',
      'claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp',
      'claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp',
    ]) expect(t).toContain(s)
    // Every command install.sh prints appears here verbatim (the Codex lines carry their verify note).
    const commands = readFileSync(installSh, 'utf8').split('\n').filter((l) => /^(?:npx|claude|codex) /.test(l))
    expect(commands.length).toBeGreaterThanOrEqual(6)
    for (const c of commands) expect(t).toContain(c)
    for (const s of ['.cursor/mcp.json', '"serverUrl"', '.vscode/mcp.json', '"servers"', '"type": "http"']) expect(t).toContain(s)
  })
})

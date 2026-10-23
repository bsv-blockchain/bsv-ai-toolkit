import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// The WriteChoice hand-off: the briefing, the draft "Coding with agents" page and the community skills list.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const docsDir = join(repoRoot, 'docs', 'writechoice')
const assetsDir = join(repoRoot, 'packages', 'skill', 'skills', 'bsv-dev', 'assets')

function read(path: string) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
const briefing = () => read(join(docsDir, 'briefing.md'))
const page = () => read(join(docsDir, 'coding-with-agents.md'))

const INSTALL_STRINGS = [
  'npx skills add bsv-blockchain/bsv-ai-toolkit',
  'claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv',
  'claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp',
  'claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp',
]

describe('docs/writechoice', () => {
  it('writechoice pages carry the install names and the three commands', () => {
    for (const [name, text] of [['briefing.md', briefing()], ['coding-with-agents.md', page()]]) {
      expect(text, name).toContain('bsv-docs')
      expect(text, name).toContain('bsv-mcp')
      for (const s of INSTALL_STRINGS) expect(text, `${name}: ${s}`).toContain(s)
    }
  })

  it('briefing lists the required stubs and the violating samples', () => {
    const text = briefing()
    for (const stub of [
      'get-started/quick-start-server',
      'guides/services/broadcasting',
      'guides/go-to-mainnet',
      'reference/networks',
      'wallets/bsv-desktop',
      'sdk/defaults',
      'build-with-ai/skill',
    ]) {
      expect(text, stub).toContain(stub)
    }
    expect(text).toContain('example_building_custom_tx_broadcaster')
    expect(text).toContain('event_tickets')
    expect(text).toContain('/reference/arc/')
    for (const id of ['G-06', 'G-09', 'G-12']) expect(text, id).toContain(id)
    // The hosted origin of the sample is not known yet.
    expect(text).toContain('https://tipping.bsvb.tech')
    expect(text).toContain('TODO(hosting)')
  })

  it('briefing never recommends 1 sat/kB as a rate to configure', () => {
    // content/facts/fees.md: configure 100 sat/kB on both networks; testnet's 1 sat/kB minimum is refused on mainnet.
    for (const [name, text] of [['briefing.md', briefing()], ['coding-with-agents.md', page()]]) {
      for (const line of text.split('\n').filter((l) => /\b1 sat\/kB/.test(l))) {
        expect(line, `${name}: ${line}`).toMatch(/100 sat\/kB/)
        expect(line, `${name}: ${line}`).toMatch(/refuse/i)
      }
    }
    expect(briefing()).toMatch(/configure 100 sat\/kB on both networks/i)
  })

  it('briefing quotes the CLAUDE.md snippet in full', () => {
    const snippet = read(join(assetsDir, 'CLAUDE.md.snippet')).trim()
    expect(snippet).not.toBe('')
    expect(briefing()).toContain(snippet)
  })

  it('coding-with-agents has its frontmatter and the client JSON from install-commands.md', () => {
    const text = page()
    expect(text).toMatch(/^---\ntitle: Coding with agents\ndescription: \S.*\n---\n/)
    const install = read(join(assetsDir, 'install-commands.md'))
    const blocks = [...install.matchAll(/```json\n[\s\S]*?```/g)].map((m) => m[0])
    expect(blocks).toHaveLength(3)
    for (const block of blocks) expect(text).toContain(block)
    expect(text).toContain('BSV_MCP_ALLOW_MAINNET_BROADCAST')
    expect(text).toContain('community-skills.yaml')
  })

  it('community-skills.yaml is an empty list with its schema comment', () => {
    const raw = read(join(repoRoot, 'community-skills.yaml'))
    expect(raw).toContain('# { name, repo, commit, description, maintainer }')
    expect(parse(raw)).toEqual({ skills: [] })
  })

  it('writechoice pages name no private material or local paths', () => {
    for (const text of [briefing(), page()]) {
      expect(text).not.toBe('')
      expect(text).not.toMatch(/chess|tic-tac-toe|\/Users\//i)
    }
  })

  it('anti-goals.sh passes on docs/writechoice', () => {
    const r = spawnSync('bash', [join(repoRoot, 'scripts', 'anti-goals.sh'), docsDir], { cwd: repoRoot, encoding: 'utf8' })
    const out = r.stdout + r.stderr
    expect(out).not.toContain('anti-goal hit')
    // A missing directory is skipped by the script; require that it was scanned.
    expect(out).toContain('anti-goals: ok (1 path(s) scanned)')
    expect(r.status).toBe(0)
  })
})

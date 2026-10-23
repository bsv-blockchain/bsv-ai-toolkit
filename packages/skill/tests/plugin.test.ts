import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (p: string) => readFileSync(root + p, 'utf8')
const plugin = JSON.parse(read('packages/skill/.claude-plugin/plugin.json'))
const frontmatter = (md: string) => md.match(/^---\n([\s\S]*?)\n---/)![1]

describe('plugin.json', () => {
  it('bundles both MCPs with the pinned @bsv/mcp version', () => {
    expect(plugin.mcpServers['bsv-mcp'].args).toEqual(['-y', '@bsv/mcp@2.0.0'])
    expect(plugin.mcpServers['bsv-docs']).toEqual({ type: 'http', url: 'https://bsv.writedocs.io/mcp' })
    expect(JSON.stringify(plugin)).not.toContain('CLAUDE_PLUGIN_ROOT')
  })

  it('exposes only bsv_network and arcade_url', () => {
    expect(Object.keys(plugin.userConfig).sort()).toEqual(['arcade_url', 'bsv_network'])
    expect(plugin.userConfig.bsv_network.default).toBe('testnet')
    expect(plugin.userConfig.bsv_network.options).toEqual(['testnet', 'mainnet'])
    // The mainnet-broadcast opt-in stays a shell variable: never an option, never passed to the MCP.
    // (bsv_network's description names it so users know where it lives.)
    expect(Object.keys(plugin.userConfig).join()).not.toMatch(/allow/i)
    expect(Object.keys(plugin.mcpServers['bsv-mcp'].env).sort()).toEqual(['ARCADE_URL', 'BSV_NETWORK'])
    expect(JSON.stringify(plugin.mcpServers)).not.toContain('ALLOW_MAINNET')
  })

  it('version matches the skill metadata and @bsv/mcp pin', () => {
    expect(read('packages/skill/skills/bsv-dev/SKILL.md')).toMatch(/version: "0\.1\.0"/)
    expect(plugin.version).toBe('0.1.0')
    const mcp = JSON.parse(read('packages/mcp/package.json'))
    expect(plugin.mcpServers['bsv-mcp'].args[1]).toBe(`@bsv/mcp@${mcp.version}`)
  })

  it('marketplaces agree', () => {
    const a = JSON.parse(read('.claude-plugin/marketplace.json'))
    const b = JSON.parse(read('packages/skill/.claude-plugin/marketplace.json'))
    expect(a.name).toBe('bsv')
    expect(b.name).toBe('bsv')
    expect(a.plugins[0].source).toBe('./packages/skill')
    expect(b.plugins[0].source).toBe('.')
    expect({ ...a.plugins[0], source: '.' }).toEqual(b.plugins[0])
    expect(a.plugins[0].name).toBe(plugin.name)
    expect(a.plugins[0].description).toBe(plugin.description)
  })

  // Needs the claude CLI, so it runs only with CLAUDE_CLI_TESTS=1. A directory holding a marketplace.json
  // validates only that file, so plugin.json and the component directories are validated explicitly too.
  it.skipIf(!process.env.CLAUDE_CLI_TESTS)('passes claude plugin validate --strict on both roots', () => {
    const targets = ['packages/skill', 'packages/skill/.claude-plugin/plugin.json', 'packages/skill/commands', 'packages/skill/skills', '']
    for (const t of targets) {
      const dir = root + t
      expect(() => execFileSync('claude', ['plugin', 'validate', '--strict', dir], { stdio: 'pipe' })).not.toThrow()
    }
  }, 60_000)
})

describe('slash commands', () => {
  it('/bsv-review resolves the path to an absolute one and walks the guardrails', () => {
    const md = read('packages/skill/commands/bsv-review.md')
    expect(frontmatter(md)).toMatch(/^description: Review a BSV project against the guardrails$/m)
    expect(frontmatter(md)).toMatch(/^argument-hint: \[path\]$/m)
    expect(md).toContain('$ARGUMENTS')
    expect(md).toMatch(/absolute/i)
    for (const s of ['check_guardrails', 'manualChecklist', 'bsv://guardrails', 'threat-model.md', 'G-34']) expect(md).toContain(s)
  })

  it('/bsv-design writes the design into the user project', () => {
    const md = read('packages/skill/commands/bsv-design.md')
    expect(frontmatter(md)).toMatch(
      /^description: Interview, then write a BSV app design \(custody shape, protocols, manifest, tx shapes, trust model\)$/m,
    )
    for (const s of ['custody-shapes.md', 'manifest.template.json', 'threat-model.md', 'docs/design/']) expect(md).toContain(s)
  })
})

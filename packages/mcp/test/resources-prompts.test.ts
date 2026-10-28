import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { mockFetch } from './helpers/mockFetch.js'

const STATIC_URIS = [
  'bsv://facts/arcade',
  'bsv://facts/networks',
  'bsv://facts/whatsonchain',
  'bsv://facts/wallet-limits',
  'bsv://facts/consensus',
  'bsv://facts/fees',
  'bsv://facts/runar',
  'bsv://facts/tokens-1color',
  'bsv://facts/versions',
  'bsv://facts/payment-channels',
  'bsv://guardrails',
  'bsv://custody-shapes',
  'bsv://threat-model',
  'bsv://docs/index',
  'bsv://simple/api',
  'bsv://simple/gotchas',
]
const PROMPTS = ['review_against_guardrails', 'tokenize_with_1color', 'integrate_simple', 'add_simple_feature', 'debug_simple']
const BROKEN_A = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects', 'broken-a')
const PREFIX = /^verified: \d{4}-\d{2}-\d{2}\nsource: @bsv\/mcp v2\.0\.0\n\n/

let client: Client
beforeAll(async () => {
  const server = createServer(loadConfig({}), { fetchImpl: mockFetch([]) })
  client = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterAll(async () => {
  await client.close()
})

async function readText(uri: string): Promise<{ text: string; mimeType?: string }> {
  const r = await client.readResource({ uri })
  const c = r.contents[0] as { text: string; mimeType?: string }
  return { text: c.text, mimeType: c.mimeType }
}

async function promptText(name: string, args: Record<string, string>): Promise<string> {
  const r = await client.getPrompt({ name, arguments: args })
  return r.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n')
}

describe('resources', () => {
  it('lists all 16 static resources and the brc template', async () => {
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)
    for (const uri of STATIC_URIS) expect(uris).toContain(uri)
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('bsv://brc/{id}')
  })

  it('every resource body starts with verified: and source:', async () => {
    for (const uri of STATIC_URIS) {
      const { text, mimeType } = await readText(uri)
      if (mimeType === 'application/json') {
        // JSON bodies stay valid JSON: the same two fields sit at the top of the object.
        const body = JSON.parse(text)
        expect(Object.keys(body).slice(0, 2), uri).toEqual(['verified', 'source'])
        expect(body.verified, uri).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(body.source, uri).toBe('@bsv/mcp v2.0.0')
      } else {
        expect(mimeType, uri).toBe('text/markdown')
        expect(text, uri).toMatch(PREFIX)
        expect(text, uri).not.toMatch(/^---$/m) // frontmatter is replaced by the prefix
      }
    }
  })

  it('docs index is JSON with the index under `index`', async () => {
    const { text, mimeType } = await readText('bsv://docs/index')
    expect(mimeType).toBe('application/json')
    const body = JSON.parse(text)
    expect(body.index.hosts.length).toBeGreaterThan(0)
    expect(Object.keys(body.index.ids).length).toBeGreaterThan(0)
  })

  it('guardrails resource has 38 headings', async () => {
    const { text } = await readText('bsv://guardrails')
    const headings = text.match(/^## G-\d{2} .+$/gm) ?? []
    expect(headings.length).toBe(38)
    expect(headings[0]).toMatch(/^## G-01 /)
    expect(headings[37]).toMatch(/^## G-38 /)
  })
})

describe('guardrail refs', () => {
  it('a check_guardrails finding ref resolves to that rule', async () => {
    const r = await client.callTool({ name: 'check_guardrails', arguments: { path: BROKEN_A } })
    const findings = (r.structuredContent as { findings: { id: string; ref: string }[] }).findings
    expect(findings.length).toBeGreaterThan(0)
    const { id, ref } = findings[0]
    expect(ref).toBe(`bsv://guardrails#${id}`)
    const { text, mimeType } = await readText(ref)
    expect(mimeType).toBe('text/markdown')
    expect(text).toMatch(PREFIX)
    expect(text.match(/^## G-\d{2} .+$/gm)).toEqual([expect.stringMatching(new RegExp(`^## ${id} `))])
  })

  it('every guardrail id has a fragment resource; unknown ids are rejected', async () => {
    for (let n = 1; n <= 38; n++) {
      const id = `G-${String(n).padStart(2, '0')}`
      expect((await readText(`bsv://guardrails#${id}`)).text).toMatch(new RegExp(`^## ${id} `, 'm'))
    }
    await expect(client.readResource({ uri: 'bsv://guardrails#G-99' })).rejects.toThrow(/unknown guardrail: G-99/)
  })
})

describe('prompts', () => {
  it('lists the five prompts', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual([...PROMPTS].sort())
  })

  it('prompt names have no leading slash', async () => {
    const { prompts } = await client.listPrompts()
    for (const p of prompts) expect(p.name.startsWith('/')).toBe(false)
  })

  it('review_against_guardrails mentions check_guardrails and manualChecklist', async () => {
    const text = await promptText('review_against_guardrails', { path: '/abs/project' })
    expect(text).toContain('check_guardrails')
    expect(text).toContain('manualChecklist')
    expect(text).toContain('/abs/project')
    expect(text).toContain('bsv://guardrails')
    expect(text).toMatch(/absolute/i)
  })

  it('simple prompts read the simple resources, default to testnet and route tracking to Arcade', async () => {
    const texts = [
      await promptText('integrate_simple', { framework: 'next' }),
      await promptText('add_simple_feature', { feature: 'payments' }),
      await promptText('debug_simple', { symptom: 'pay() returned an empty txid' }),
    ]
    for (const text of texts) {
      expect(text).toContain('bsv://simple/api')
      expect(text).toContain('bsv://simple/gotchas')
      expect(text).toContain("network: 'testnet'")
      expect(text).toContain('@bsv/sdk')
      expect(text).toContain('SEEN_ON_NETWORK')
      expect(text).toContain("map `mainnet` to `'main'`")
      expect(text).toContain("`Overlay.create` takes `'testnet'|'mainnet'`")
    }
  })

  it('money paths gate on the app\'s own Arcade client; the MCP tools are the dev-time equivalent', async () => {
    const texts = [
      await promptText('integrate_simple', { framework: 'node' }),
      await promptText('add_simple_feature', { feature: 'payments' }),
      await promptText('tokenize_with_1color', { mode: 'deploy' }),
    ]
    for (const text of texts) {
      expect(text).toContain("In app code, submit to the app's own Arcade client (`POST /tx` as EF hex) and gate on `GET /tx/{txid}`")
      expect(text).toContain('While developing, `arcade_submit`/`arcade_status` do the same from here.')
      expect(text).not.toMatch(/gate on `arcade_status`/)
    }
  })

  it('tokenize_with_1color points at the facts and states phase-1 scope', async () => {
    const text = await promptText('tokenize_with_1color', { mode: 'transfer', assetId: 'ab'.repeat(32) + '_0' })
    expect(text).toContain('bsv://facts/tokens-1color')
    expect(text).toMatch(/phase 1/i)
    expect(text).toContain('@bsv/wallet-toolbox')
    expect(text).toContain('BSV Desktop')
    expect(text).toContain('ab'.repeat(32) + '_0')
  })

  it('no prompt asks for a private key or points at ARC or WhatsOnChain as truth', async () => {
    const texts = [
      await promptText('review_against_guardrails', { path: '/abs/project' }),
      await promptText('tokenize_with_1color', { mode: 'deploy' }),
      await promptText('integrate_simple', { framework: 'express' }),
      await promptText('add_simple_feature', { feature: 'tokens' }),
      await promptText('debug_simple', { symptom: 'x' }),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/\/v1\/tx/)
      expect(text).not.toMatch(/new ARC\b/)
      expect(text).not.toMatch(/(paste|share|send|give) (me )?(your |the )?(private key|WIF|seed)/i)
    }
  })
})

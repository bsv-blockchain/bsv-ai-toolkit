import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { parse as parseYaml } from 'yaml'
import type { Config } from '../config.js'
import { CONTENT_DIR } from '../content.js'
import { registerBrcResource } from '../tools/brc.js'
import { loadDocsIndex } from '../tools/docs.js'
import { loadVersionsFile } from '../tools/versions.js'

/** One item of `content/guardrails.json` (the YAML list as JSON). */
interface Guardrail {
  id: string
  title: string
  shape: 'A' | 'B' | 'both'
  rule: string
  why: string
  detect: 'static' | 'manual' | 'contract'
  severity: 'error' | 'warn'
  refs: string[]
}

const FACTS = ['arcade', 'networks', 'whatsonchain', 'wallet-limits', 'consensus', 'fees', 'runar', 'tokens-1color', 'versions']

// Markdown resources backed by one content file each; the file's frontmatter supplies `title` and `verified`.
const MARKDOWN: { name: string; uri: string; file: string; description: string }[] = [
  ...FACTS.map((f) => ({ name: `facts-${f}`, uri: `bsv://facts/${f}`, file: `facts/${f}.md`, description: `Dated BSV facts: ${f}` })),
  { name: 'custody-shapes', uri: 'bsv://custody-shapes', file: 'custody-shapes.md', description: 'Shape A (user wallet) and shape B (server wallet): who holds the keys that move money' },
  { name: 'threat-model', uri: 'bsv://threat-model', file: 'threat-model.md', description: 'What a BSV app defends against, what it does not, and what it must tell users' },
  { name: 'simple-api', uri: 'bsv://simple/api', file: 'simple/api.md', description: 'The @bsv/simple 0.7 API surface' },
  { name: 'simple-gotchas', uri: 'bsv://simple/gotchas', file: 'simple/gotchas.md', description: '@bsv/simple 0.7 traps and what to do instead' },
]

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function prefix(verified: string, version: string): string {
  return `verified: ${verified}\nsource: @bsv/mcp v${version}\n\n`
}

/** Reads a content Markdown file and replaces its frontmatter with the `verified:`/`source:` prefix. */
export function loadMarkdownResource(file: string, version: string, contentDir = CONTENT_DIR): { title: string; text: string } {
  const raw = readFileSync(join(contentDir, file), 'utf8')
  const m = FRONTMATTER.exec(raw)
  if (!m) throw new Error(`${file}: no frontmatter`)
  const meta = (parseYaml(m[1]) ?? {}) as Record<string, unknown>
  const verified = String(meta.verified ?? '')
  if (!DATE.test(verified)) throw new Error(`${file}: frontmatter needs verified: YYYY-MM-DD`)
  if (typeof meta.title !== 'string' || meta.title === '') throw new Error(`${file}: frontmatter needs title`)
  return { title: meta.title, text: prefix(verified, version) + raw.slice(m[0].length).trimStart() }
}

function refLabel(ref: string): string {
  const [kind, value] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]
  if (kind === 'brc') return `\`bsv://brc/${value.padStart(4, '0')}\``
  if (kind === 'fact') return `\`bsv://facts/${value}\``
  if (kind === 'docs') return `\`docs_url\` id \`${value}\``
  return `\`${ref}\``
}

/** Renders `guardrails.json` as Markdown, one `## G-xx <title>` section per rule. */
export function renderGuardrails(version: string, contentDir = CONTENT_DIR): string {
  const rules = JSON.parse(readFileSync(join(contentDir, 'guardrails.json'), 'utf8')) as Guardrail[]
  const { verified } = loadVersionsFile(contentDir)
  const sections = rules.map((g) =>
    [
      `## ${g.id} ${g.title}`,
      '',
      `**Rule:** ${g.rule}`,
      '',
      `**Why:** ${g.why}`,
      '',
      `- Shape: ${g.shape}`,
      `- Detect: ${g.detect}`,
      `- Severity: ${g.severity}`,
      `- Refs: ${g.refs.map(refLabel).join(', ') || 'none'}`,
    ].join('\n'),
  )
  const intro = [
    '# Guardrails',
    '',
    'Each rule names the custody shape it applies to (A, B or both; see `bsv://custody-shapes`) and how it is checked: ' +
      '`static` rules are checked by the `check_guardrails` tool, `manual` and `contract` rules by review.',
  ].join('\n')
  return prefix(verified, version) + [intro, ...sections].join('\n\n') + '\n'
}

/** `docs-index.json` wrapped so the body stays valid JSON: `{ verified, source, index }`. */
export function renderDocsIndex(version: string, contentDir = CONTENT_DIR): string {
  const { verified } = loadVersionsFile(contentDir)
  return JSON.stringify({ verified, source: `@bsv/mcp v${version}`, index: loadDocsIndex(contentDir) }, null, 2) + '\n'
}

/** Registers the 15 static `bsv://` resources and the `bsv://brc/{id}` template. Content is read once, here. */
export function registerResources(server: McpServer, cfg: Config, fetchImpl: typeof fetch): void {
  for (const r of MARKDOWN) {
    const { title, text } = loadMarkdownResource(r.file, cfg.version)
    server.registerResource(r.name, r.uri, { title, description: r.description, mimeType: 'text/markdown' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
    }))
  }

  const guardrails = renderGuardrails(cfg.version)
  server.registerResource(
    'guardrails',
    'bsv://guardrails',
    { title: 'Guardrails G-01..G-34', description: 'Every guardrail with its rule, reason, shape, detection and refs', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guardrails }] }),
  )

  const docsIndex = renderDocsIndex(cfg.version)
  server.registerResource(
    'docs-index',
    'bsv://docs/index',
    {
      title: 'Docs index',
      description: 'Ids, paths and titles of the BSV docs pages; resolve an id to a live URL with the docs_url tool',
      mimeType: 'application/json',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: docsIndex }] }),
  )

  registerBrcResource(server, cfg, fetchImpl)
}

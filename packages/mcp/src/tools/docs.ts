import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CONTENT_DIR } from '../content.js'
import { errorResult, textResult } from './result.js'

/** The parsed `content/docs-index.json`. */
export interface DocsIndex {
  hosts: string[]
  ids: Record<string, { path: string; title: string; legacy?: string }>
}

export type DocsHit = { id: string; title: string; url: string; markdownUrl: string; host: string }
export type DocsMiss = { id: string; error: string; tried: string[] }

const TIMEOUT_MS = 10_000
const SOFT_404 = '# Page Not Found'

export function loadDocsIndex(contentDir = CONTENT_DIR): DocsIndex {
  return JSON.parse(readFileSync(join(contentDir, 'docs-index.json'), 'utf8'))
}

/**
 * Resolves a docs-index id to a live page: tries `<host><path>.md` on each host in order, then the id's
 * `legacy` URL. A hit is an answer below 400 whose body does not start with `# Page Not Found` (the soft 404
 * docs.bsvblockchain.org serves with HTTP 200). Mirrors the `page` rule of packages/sync/src/links.ts, which
 * is a private workspace package and not a dependency of @bsv/mcp.
 */
export async function resolveDocsUrl(id: string, index: DocsIndex, fetchImpl: typeof fetch): Promise<DocsHit | DocsMiss> {
  const entry = Object.hasOwn(index.ids, id) ? index.ids[id] : undefined
  if (!entry) {
    return { id, error: `unknown docs id "${id}"; known ids: ${Object.keys(index.ids).sort().join(', ')}`, tried: [] }
  }

  const candidates = index.hosts.map((host) => ({ host, markdownUrl: `${host}${entry.path}.md` }))
  if (entry.legacy) candidates.push({ host: `${new URL(entry.legacy).origin}/`, markdownUrl: entry.legacy })

  const tried: string[] = []
  const misses: string[] = []
  for (const { host, markdownUrl } of candidates) {
    tried.push(markdownUrl)
    const miss = await checkPage(markdownUrl, fetchImpl)
    if (miss === undefined) {
      return { id, title: entry.title, url: markdownUrl.replace(/\.md$/, ''), markdownUrl, host }
    }
    misses.push(`${markdownUrl} (${miss})`)
  }
  return { id, error: `no live page for "${id}": ${misses.join(', ')}`, tried }
}

// undefined on a hit, else why it missed.
async function checkPage(url: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  let res: Response
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    return `no answer: ${e instanceof Error ? e.message : String(e)}`
  }
  if (res.status >= 400) return `HTTP ${res.status}`
  const body = await res.text().catch(() => '')
  if (body.trimStart().startsWith(SOFT_404)) return 'soft 404'
  return undefined
}

export function registerDocsTools(server: McpServer, fetchImpl: typeof fetch, index: DocsIndex = loadDocsIndex()): void {
  server.registerTool(
    'docs_url',
    {
      description:
        'Resolve a BSV docs id (bsv://docs/index) to a live page URL and its Markdown URL. Tries each docs host in order, ' +
        'then the legacy URL; a "Page Not Found" body counts as a miss.',
      inputSchema: { id: z.string().describe('Docs id, e.g. guides.payments') },
    },
    async ({ id }) => {
      try {
        const r = await resolveDocsUrl(id, index, fetchImpl)
        if ('error' in r) return { ...textResult(r.error, r), isError: true }
        return textResult(JSON.stringify(r, null, 2), r)
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}

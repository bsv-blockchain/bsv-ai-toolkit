import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../config.js'
import { CONTENT_DIR } from '../content.js'
import { errorResult, textResult } from './result.js'

export interface BrcCategories {
  verified: string
  categories: string[]
  index: Record<string, string>
}

export interface BrcDocument {
  markdown: string
  source: 'local' | 'github'
  url: string
}

const GITHUB_RAW = 'https://raw.githubusercontent.com/bsv-blockchain/BRCs/master'
const TIMEOUT_MS = 10_000
const CATEGORY = /^[a-z0-9][a-z0-9-]*$/

export function loadBrcCategories(contentDir = CONTENT_DIR): BrcCategories {
  return JSON.parse(readFileSync(join(contentDir, 'brc-categories.json'), 'utf8'))
}

/** '1', '0001', 'BRC-1', 'brc1', ' brc-0001 ' → '0001'; anything that is not a BRC number → null. */
export function normalizeBrcId(input: string): string | null {
  const m = /^(?:brc[-_ ]?)?(\d{1,6})$/i.exec(input.trim())
  if (!m) return null
  return m[1].replace(/^0+(?=\d)/, '').padStart(4, '0')
}

/**
 * Reads BRC `id` from the local clone (`${reposDir}/BRCs/<category>/<id>.md`, every directory of the clone,
 * the indexed category first), else from GitHub raw on master (the indexed category, then every known one).
 */
export async function lookupBrc(
  id: string,
  cfg: Config,
  fetchImpl: typeof fetch,
  categories: BrcCategories = loadBrcCategories(),
): Promise<BrcDocument> {
  const n = normalizeBrcId(id)
  if (n === null) throw new Error(`not a BRC number: "${id}" (try 29, 0029 or BRC-29)`)
  const indexed = categories.index[n]

  if (cfg.reposDir !== undefined) {
    const local = await readLocal(n, resolve(cfg.reposDir, 'BRCs'), indexed)
    if (local) return local
  }

  const order = [...new Set([indexed, ...categories.categories])].filter((c): c is string => typeof c === 'string' && CATEGORY.test(c))
  const failures: string[] = []
  for (const category of order) {
    const url = `${GITHUB_RAW}/${category}/${n}.md`
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return { markdown: await res.text(), source: 'github', url }
      if (res.status !== 404) failures.push(`${url} answered ${res.status}`)
    } catch (e) {
      failures.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const where = cfg.reposDir === undefined ? 'BSV_REPOS_DIR is not set' : `not in ${join(cfg.reposDir, 'BRCs')}`
  const detail = failures.length ? `; ${failures.join('; ')}` : ''
  throw new Error(`BRC ${n} not found (${where}; not on GitHub under ${order.join(', ')})${detail}`)
}

async function readLocal(n: string, root: string, indexed: string | undefined): Promise<BrcDocument | undefined> {
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return undefined // no local clone
  }
  if (indexed !== undefined && dirs.includes(indexed)) dirs = [indexed, ...dirs.filter((d) => d !== indexed)]
  for (const dir of dirs) {
    const file = resolve(root, dir, `${n}.md`)
    if (!file.startsWith(root + sep)) continue // never read outside the clone
    try {
      return { markdown: await readFile(file, 'utf8'), source: 'local', url: pathToFileURL(file).href }
    } catch {
      // not in this category
    }
  }
  return undefined
}

export function registerBrcTools(server: McpServer, cfg: Config, fetchImpl: typeof fetch): void {
  server.registerTool(
    'brc_lookup',
    {
      description:
        'Read a BRC (BSV Request for Comments) as Markdown: from the local BRCs clone under BSV_REPOS_DIR when present, ' +
        'otherwise from github.com/bsv-blockchain/BRCs. Accepts 29, 0029 or BRC-29.',
      inputSchema: { brc: z.string().describe('BRC number, e.g. 29, 0029 or BRC-29') },
    },
    async ({ brc }) => {
      try {
        const doc = await lookupBrc(brc, cfg, fetchImpl)
        return textResult(doc.markdown, { id: normalizeBrcId(brc), source: doc.source, url: doc.url })
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}

/** Registers the `bsv://brc/{id}` resource template, backed by lookupBrc. */
export function registerBrcResource(server: McpServer, cfg: Config, fetchImpl: typeof fetch): void {
  server.registerResource(
    'brc',
    new ResourceTemplate('bsv://brc/{id}', { list: undefined }),
    { title: 'BRC', description: 'A BRC (BSV Request for Comments) as Markdown, e.g. bsv://brc/0029', mimeType: 'text/markdown' },
    async (uri, { id }) => {
      const doc = await lookupBrc(String(id), cfg, fetchImpl)
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.markdown }] }
    },
  )
}

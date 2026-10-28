import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import { DocsIndexFile } from './schema.js'

export interface BrokenLink {
  url: string
  file: string
  status: number
}

const TIMEOUT_MS = 10_000
const CONCURRENCY = 8
const SCANNED = ['**/*.md', '**/*.yaml', '**/*.yml', '**/*.json']
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]|]+/g
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * `page`: must answer < 400 and not be a soft 404 (a body starting `# Page Not Found`, which
 * docs.bsvblockchain.org serves with HTTP 200). `reachable`: any HTTP answer below 500 will do; used for
 * bare origins and for API bases written as inline code, which are hosts, not pages.
 */
type Mode = 'page' | 'reachable'

interface Found {
  url: string
  file: string
  mode: Mode
}

/**
 * Checks every http(s) URL in the Markdown/YAML/JSON files under `contentDir` and `extraDirs`, and in the files
 * matching the `extraFiles` glob patterns (each URL once, attributed to the first file it appears in), and every
 * `docs-index.yaml` id, which passes when any of `<host><path>.md` or its `legacy` URL is a hit (same rule as
 * `docs_url`); a failing id is reported once, against its first host URL. A URL of a docs-index id found in any
 * scanned file is judged by that id rule, not fetched as a page.
 * HEAD first, GET when HEAD fails or the body must be inspected; 10 s timeout; status 0 means no answer.
 */
export async function checkLinks(contentDir: string, extraDirs: string[], extraFiles: string[] = []): Promise<{ broken: BrokenLink[] }> {
  const indexFile = join(contentDir, 'docs-index.yaml')
  const index = existsSync(indexFile) ? DocsIndexFile.parse(parseYaml(await readFile(indexFile, 'utf8'))) : { hosts: [], ids: {} }
  // Each id is one check: OK when any host URL (`<host><path>.md`) or its legacy URL is a hit.
  const ids = Object.values(index.ids).map((entry) => [
    ...index.hosts.map((host) => `${host}${entry.path}.md`),
    ...(entry.legacy ? [entry.legacy] : []),
  ])
  // Literal occurrences of an id's URLs (e.g. the generated Docs links list) are judged by the id rule.
  const idUrls = new Set(ids.flat())
  for (const entry of Object.values(index.ids)) for (const host of index.hosts) idUrls.add(`${host}${entry.path}`)

  const files: string[] = []
  for (const dir of [contentDir, ...extraDirs]) {
    if (!existsSync(dir)) continue
    // The docs index lists host prefixes, not pages; it is checked by id below.
    for (const rel of (await fg(SCANNED, { cwd: dir, onlyFiles: true })).sort()) {
      if (!basename(rel).startsWith('docs-index.')) files.push(join(dir, rel))
    }
  }
  if (extraFiles.length) files.push(...(await fg(extraFiles, { onlyFiles: true })).sort())

  const found = new Map<string, Found>()
  for (const file of files) {
    for (const f of extractUrls(await readFile(file, 'utf8'), file, file.endsWith('.md'))) {
      if (!idUrls.has(f.url) && !found.has(f.url)) found.set(f.url, f)
    }
  }

  const checker = new Checker()
  const literal = [...found.values()]
  const literalResults = await mapLimit(literal, CONCURRENCY, (f) => checker.check(f.url, f.mode))
  const idResults = await mapLimit(ids, CONCURRENCY, async (urls) => {
    let first: number | undefined
    for (const url of urls) {
      const status = await checker.check(url, 'page')
      if (status === 'ok') return 'ok'
      first ??= status
    }
    return first ?? 0
  })

  const broken: BrokenLink[] = []
  literal.forEach((f, i) => {
    const r = literalResults[i]
    if (r !== 'ok') broken.push({ url: f.url, file: f.file, status: r })
  })
  ids.forEach((urls, i) => {
    const r = idResults[i]
    if (r !== 'ok' && urls.length) broken.push({ url: urls[0], file: indexFile, status: r })
  })
  return { broken }
}

function extractUrls(text: string, file: string, markdown: boolean): Found[] {
  const out: Found[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (markdown && /^\s*(`{3,}|~{3,})/.test(line)) {
      fence = !fence
      continue
    }
    for (const match of line.matchAll(URL_PATTERN)) {
      const url = match[0].replace(/[.,;:!?]+$/, '')
      if (!checkable(url)) continue
      const inCode = markdown && (fence || (line.slice(0, match.index).match(/`/g)?.length ?? 0) % 2 === 1)
      out.push({ url, file, mode: inCode || isBareOrigin(url) ? 'reachable' : 'page' })
    }
  }
  return out
}

function checkable(url: string): boolean {
  if (/[{}]/.test(url)) return false
  try {
    const host = new URL(url).hostname
    return host !== '' && !LOCAL_HOSTS.has(host) && !host.endsWith('.localhost')
  } catch {
    return false
  }
}

function isBareOrigin(url: string): boolean {
  const u = new URL(url)
  return u.pathname === '/' && u.search === '' && u.hash === ''
}

class Checker {
  private readonly cache = new Map<string, Promise<'ok' | number>>()

  check(url: string, mode: Mode): Promise<'ok' | number> {
    const key = `${mode} ${url}`
    let result = this.cache.get(key)
    if (!result) {
      result = checkUrl(url, mode)
      this.cache.set(key, result)
    }
    return result
  }
}

async function request(url: string, method: 'HEAD' | 'GET'): Promise<Response | undefined> {
  try {
    return await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return undefined
  }
}

async function checkUrl(url: string, mode: Mode): Promise<'ok' | number> {
  const passes = (status: number) => (mode === 'reachable' ? status < 500 : status < 400)
  const head = await request(url, 'HEAD')
  if (head && passes(head.status) && !(mode === 'page' && mayBeSoft404(url, head))) return 'ok'
  const get = await request(url, 'GET')
  if (!get) return 0
  if (!passes(get.status)) return get.status
  if (mode === 'page' && (await get.text()).trimStart().startsWith('# Page Not Found')) return get.status
  return 'ok'
}

/** A Markdown or plain-text page that answered HEAD 2xx may still be a soft 404; its body has to be read. */
function mayBeSoft404(url: string, head: Response): boolean {
  const type = head.headers.get('content-type') ?? ''
  return url.endsWith('.md') || type.includes('markdown') || type.startsWith('text/plain')
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

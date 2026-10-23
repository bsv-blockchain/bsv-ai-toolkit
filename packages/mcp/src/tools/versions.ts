import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ArcadeClient } from '../arcade/client.js'
import type { TxStatus, VersionRow } from '../types.js'
import { CONTENT_DIR } from '../content.js'
import { errorResult, textResult } from './result.js'

/** The parsed `content/versions.json`. */
export interface VersionsFile {
  verified: string
  packages: Record<string, { pinned: string; verified: string; note?: string }>
  git: Record<string, { repo: string; branch: string; commit: string; version: string; verified: string; npmVersion?: string; npmUnsafe?: boolean }>
  services: {
    arcade: { version: string; verified: string; hosts: { testnet: string[]; mainnet: string[]; ttn?: string[] }; probeTxid: string }
  }
  runtime: Record<string, string>
}

export interface RawTxProbe {
  txid: string
  rawTxPresent: boolean
  txStatus: TxStatus
}

type Judge = (latest: string) => { drift: boolean; note?: string }

export interface VersionsReport {
  rows: VersionRow[]
  rawTxProbe?: RawTxProbe
}

const TIMEOUT_MS = 10_000
const DAY_MS = 86_400_000
const VERSION = /^v?\d+\.\d+/
// npm packages whose npm release is known stale and unsafe, keyed to the git entry that replaces them.
const NPM_UNSAFE: Record<string, string> = { 'runar-sdk': 'runar' }

export function loadVersionsFile(contentDir = CONTENT_DIR): VersionsFile {
  return JSON.parse(readFileSync(join(contentDir, 'versions.json'), 'utf8'))
}

/**
 * Compares every pinned version in versions.json with what is live: npm `latest`, the runar git branch head,
 * and `/health` on every testnet and mainnet Arcade host. A check that fails is reported as drift with the
 * error in `note`, so a broken source is never read as "up to date". The raw-tx probe runs only when
 * `services.arcade.probeTxid` is set (and `opts.probe` is not false).
 */
export async function versionsCheck(
  versions: VersionsFile,
  fetchImpl: typeof fetch,
  opts: { probe?: boolean; now?: Date } = {},
): Promise<VersionsReport> {
  const now = (opts.now ?? new Date()).getTime()
  const ageDays = (verified: string) => Math.floor((now - Date.parse(`${verified}T00:00:00Z`)) / DAY_MS)
  const row = async (name: string, pinned: string, verified: string, latest: Promise<string>, judge?: Judge): Promise<VersionRow> => {
    const base = { name, pinned, verifiedOn: verified, ageDays: ageDays(verified) }
    // An unreadable verified date cannot prove freshness, so the row fails closed.
    const badDate = Number.isFinite(base.ageDays) ? undefined : `verified date unreadable: "${verified}"`
    try {
      const l = await latest
      const { drift, note } = judge ? judge(l) : { drift: l !== pinned, note: undefined }
      const notes = [note, badDate].filter(Boolean).join('; ')
      return { ...base, latest: l, drift: drift || badDate !== undefined, ...(notes ? { note: notes } : {}) }
    } catch (e) {
      const notes = [`check failed: ${e instanceof Error ? e.message : String(e)}`, badDate].filter(Boolean).join('; ')
      return { ...base, latest: 'unknown', drift: true, note: notes }
    }
  }

  const getJson = async (url: string, headers: Record<string, string> = {}): Promise<any> => {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    return res.json()
  }

  const rows: Promise<VersionRow>[] = []

  for (const [name, p] of Object.entries(versions.packages)) {
    const latest = getJson(`https://registry.npmjs.org/${name}/latest`).then((j) => {
      const v = String(j?.version)
      if (!VERSION.test(v)) throw new Error(`registry answered a malformed version: ${v}`)
      return v
    })
    const gitKey = NPM_UNSAFE[name]
    const git = gitKey === undefined ? undefined : versions.git[gitKey]
    if (git === undefined) {
      rows.push(row(name, p.pinned, p.verified, latest, (l) => ({ drift: l !== p.pinned, note: p.note })))
      continue
    }
    // npm is not the source for this package: drift only once npm catches up with the git version.
    rows.push(
      row(name, p.pinned, p.verified, latest, (l) => {
        const lags = compareVersions(l, git.version) < 0
        const status = lags ? `npm ${l} still lags git ${git.version}` : `npm ${l} has caught up with git ${git.version}; review`
        return { drift: !lags, note: [p.note ?? 'npm is stale and unsafe', status].join('; ') }
      }),
    )
  }

  // GITHUB_TOKEN (set in CI) lifts GitHub's unauthenticated rate limit. It goes to api.github.com only and is never
  // part of a row, a note or a log line.
  const githubToken = process.env.GITHUB_TOKEN
  const githubHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': '@bsv/mcp versions_check',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  }
  for (const [key, g] of Object.entries(versions.git)) {
    const head = getJson(`https://api.github.com/repos/${g.repo}/commits/${g.branch}`, githubHeaders).then((j) => String(j.sha).slice(0, 7))
    rows.push(row(`git:${key} (${g.repo}@${g.branch})`, g.commit, g.verified, head))
  }

  const arcade = versions.services.arcade
  for (const host of [...arcade.hosts.testnet, ...arcade.hosts.mainnet]) {
    const version = new ArcadeClient({ baseUrl: host, timeoutMs: TIMEOUT_MS, fetchImpl }).health().then((h) => String(h.version))
    rows.push(row(`arcade:${new URL(host).hostname}`, arcade.version, arcade.verified, version))
  }

  const report: VersionsReport = { rows: await Promise.all(rows) }
  if (opts.probe !== false && arcade.probeTxid !== '') report.rawTxProbe = await probe(arcade.probeTxid, arcade.hosts.testnet[0], fetchImpl)
  return report
}

// Reads the probe txid's status from the first testnet Arcade: does it still return rawTx?
async function probe(txid: string, host: string, fetchImpl: typeof fetch): Promise<RawTxProbe> {
  try {
    const s = await new ArcadeClient({ baseUrl: host, timeoutMs: TIMEOUT_MS, fetchImpl }).status(txid)
    if ('notFound' in s) return { txid, rawTxPresent: false, txStatus: 'UNKNOWN' }
    return { txid, rawTxPresent: typeof s.rawTx === 'string' && s.rawTx !== '', txStatus: s.txStatus }
  } catch {
    return { txid, rawTxPresent: false, txStatus: 'UNKNOWN' }
  }
}

/** Orders `1.2.3`, `v1.2.3` and `1.0.0-rc.1` style versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}

export function formatVersionsTable(report: VersionsReport): string {
  const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
  const lines = [
    '| name | pinned | latest | verified | age (days) | drift | note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((r) =>
      `| ${cell(r.name)} | ${cell(r.pinned)} | ${cell(r.latest)} | ${r.verifiedOn} | ${r.ageDays} | ${r.drift ? 'yes' : 'no'} | ${cell(r.note ?? '')} |`,
    ),
  ]
  const p = report.rawTxProbe
  lines.push('', p ? `raw-tx probe ${p.txid}: ${p.txStatus}, rawTx ${p.rawTxPresent ? 'present' : 'absent'}` : 'raw-tx probe: skipped (no probeTxid)')
  return lines.join('\n')
}

export function registerVersionsTools(server: McpServer, fetchImpl: typeof fetch, versions: () => VersionsFile = () => loadVersionsFile()): void {
  server.registerTool(
    'versions_check',
    {
      description:
        'Compare the pinned BSV stack (npm packages, runar git head, Arcade version on every testnet and mainnet host) ' +
        'with what is live now. Returns one row per item with drift and the age of its verified date.',
      inputSchema: {},
    },
    async () => {
      try {
        const report = await versionsCheck(versions(), fetchImpl)
        return textResult(formatVersionsTable(report), report)
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}

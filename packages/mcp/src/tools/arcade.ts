import { createHash } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ArcadeClient } from '../arcade/client.js'
import { classify400, detectHexFormat, verdictOf } from '../arcade/classify.js'
import { resolveNetwork, type Config } from '../config.js'
import type { Network, StatusResult, SubmitResult, TransactionStatus, TxStatus } from '../types.js'
import { respond } from './result.js'

export interface SubmitInput {
  hex: string
  arcadeUrl?: string
  network?: Network
  waitForSeen?: boolean
  timeoutMs?: number
  callbackUrl?: string
  callbackToken?: string
  fullStatusUpdates?: boolean
}

export interface StatusInput {
  txid: string
  arcadeUrl?: string
  callbackToken?: string
}

export interface UrlInput {
  arcadeUrl?: string
}

const MAX_REQUEST_TIMEOUT_MS = 10000
const MAINNET_DISABLED = 'mainnet broadcast disabled; set BSV_MCP_ALLOW_MAINNET_BROADCAST=1'
const REJECTED_MAY_NOT_BE_FINAL = 'may not be final for a tx the network already accepted; re-read status'
const NEVER_GIVEN = 'this instance was never given this txid; submit it here to track it'
const EF_REMINDER = 'rawTx is EF (extended format); re-read as plain (Transaction.fromHexEF(hex).toHex()) before merging it into a BEEF'
const TX_STATUSES: ReadonlySet<string> = new Set<TxStatus>([
  'UNKNOWN', 'RECEIVED', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES',
  'DOUBLE_SPEND_ATTEMPTED', 'REJECTED', 'PENDING_RETRY', 'STUMP_PROCESSING', 'MINED', 'IMMUTABLE',
])

// REJECTED because a parent was rejected or an input looks spent can be a stale view of a tx the network
// already accepted elsewhere, so the verdict stays 'terminal' but the caller is told to re-read.
function rejectedMayNotBeFinal(s: { txStatus: string; extraInfo?: string }): boolean {
  if (s.txStatus !== 'REJECTED' || typeof s.extraInfo !== 'string') return false
  return /^\s*parent rejected/i.test(s.extraInfo) || /missingorspent|utxo_spent|already spent/i.test(s.extraInfo)
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const present = notes.filter((n): n is string => typeof n === 'string' && n !== '')
  return present.length > 0 ? present.join('; ') : undefined
}

// The error strings an Arcade/ARC error body may carry, most specific first.
function errorTexts(body: any): string[] {
  return [body?.extraInfo, body?.reason, body?.detail, body?.error, body?.title].filter((v): v is string => typeof v === 'string' && v !== '')
}

function errorText(body: any): string | undefined {
  return errorTexts(body)[0]
}

// Only HTTP 400/422, or a body with an ARC code in 460-476, is Arcade's verdict on the transaction itself;
// any other 4xx (401, 403, 404, 405, ...) is about the request or the URL.
function isValidationAnswer(postStatus: number, body: any): boolean {
  if (postStatus === 400 || postStatus === 422) return true
  return typeof body?.status === 'number' && body.status >= 460 && body.status <= 476
}

// The txid of a raw or EF hex (EF inputs carry the previous output's satoshis and locking script, which are
// not part of the txid). Returns undefined when the hex does not parse as a transaction.
export function txidOfHex(hex: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined
  const b = Buffer.from(hex, 'hex')
  let pos = 0
  const take = (n: number) => {
    if (n < 0 || pos + n > b.length) throw new RangeError('truncated')
    pos += n
  }
  const varint = (): number => {
    take(1)
    const first = b[pos - 1]
    if (first < 0xfd) return first
    if (first === 0xfd) return take(2), b.readUInt16LE(pos - 2)
    if (first === 0xfe) return take(4), b.readUInt32LE(pos - 4)
    take(8)
    const v = b.readBigUInt64LE(pos - 8)
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('varint too large')
    return Number(v)
  }
  try {
    const parts: Buffer[] = [b.subarray(0, 4)]
    take(4)
    const ef = b.length >= 10 && b.subarray(4, 10).equals(Buffer.from('0000000000ef', 'hex'))
    if (ef) take(6)
    let start = pos
    const inputs = varint()
    for (let i = 0; i < inputs; i++) {
      take(36) // previous txid and output index
      take(varint()) // unlocking script
      take(4) // sequence
      parts.push(b.subarray(start, pos))
      if (ef) {
        take(8) // previous satoshis
        take(varint()) // previous locking script
      }
      start = pos
    }
    const outputs = varint()
    for (let i = 0; i < outputs; i++) {
      take(8)
      take(varint())
    }
    take(4) // lock time
    if (pos !== b.length) return undefined
    parts.push(b.subarray(start))
    const raw = Buffer.concat(parts)
    const once = createHash('sha256').update(raw).digest()
    return Buffer.from(createHash('sha256').update(once).digest()).reverse().toString('hex')
  } catch {
    return undefined
  }
}

export async function arcadeSubmit(input: SubmitInput, cfg: Config, fetchImpl: typeof fetch): Promise<SubmitResult> {
  // Normalise once: the same string is format-checked and posted.
  const hex = input.hex.trim()
  if (detectHexFormat(hex) === 'beef') {
    throw new Error('BEEF is not accepted by POST /tx; convert to EF or raw hex (e.g. Transaction.fromHexBEEF(hex).toHexEF()) and submit that')
  }
  const { network, arcadeUrl, warning: hostWarning } = resolveNetwork({ network: input.network, arcadeUrl: input.arcadeUrl }, cfg)
  // Gate on the effective network only, never on the host string.
  if (network === 'mainnet' && !cfg.allowMainnetBroadcast) throw new Error(MAINNET_DISABLED)

  const waitForSeen = input.waitForSeen ?? true
  const timeoutMs = input.timeoutMs ?? 15000
  // waitForSeen can overrun its deadline by one in-flight request, so while waiting each request (the POST
  // included) gets at most min(10 s, timeoutMs). Worst case: one POST timeout + timeoutMs + one poll timeout.
  const requestTimeoutMs = waitForSeen ? Math.max(1, Math.min(MAX_REQUEST_TIMEOUT_MS, timeoutMs)) : MAX_REQUEST_TIMEOUT_MS
  const client = new ArcadeClient({ baseUrl: arcadeUrl, timeoutMs: requestTimeoutMs, fetchImpl })

  const posted = await client.submit(hex, {
    callbackUrl: input.callbackUrl,
    callbackToken: input.callbackToken,
    fullStatusUpdates: input.fullStatusUpdates,
  })
  const { postStatus, body, transient } = posted
  const bodyTxid = typeof body?.txid === 'string' && /^[0-9a-f]{64}$/i.test(body.txid) ? body.txid.toLowerCase() : undefined
  const txid = txidOfHex(hex) ?? bodyTxid ?? ''
  const base = { txid, postStatus, competingTxs: [] as string[] }
  const finish = (r: SubmitResult, ...warnings: (string | undefined)[]): SubmitResult => {
    const warning = joinNotes(hostWarning, ...warnings)
    return warning === undefined ? r : { ...r, warning }
  }

  const is2xx = postStatus >= 200 && postStatus < 300
  const is4xx = postStatus >= 400 && postStatus < 500 && postStatus !== 429
  let readStatus = is2xx
  let arcCode: number | undefined

  if (is4xx && !isValidationAnswer(postStatus, body)) {
    return finish(
      { ...base, txStatus: 'UNKNOWN', verdict: 'pending', transient: false, ...extra(errorText(body)) },
      `Arcade answered HTTP ${postStatus} — check arcadeUrl; this is not a transaction verdict`,
    )
  }

  if (is4xx) {
    const c = classify400(body)
    arcCode = c.arcCode
    if (c.kind === 'transient-476') {
      // Locktime not final yet: nothing was stored, so no status read follows.
      return finish({ ...base, txStatus: 'UNKNOWN', verdict: 'pending', arcCode: c.arcCode, transient: true, ...extra(errorText(body)) })
    }
    if (c.kind === 'terminal') {
      const blamesInputs = errorTexts(body).some((extraInfo) => rejectedMayNotBeFinal({ txStatus: 'REJECTED', extraInfo }))
      return finish(
        { ...base, txStatus: 'REJECTED', verdict: 'terminal', ...(c.arcCode === undefined ? {} : { arcCode: c.arcCode }), transient: false, ...extra(errorText(body)) },
        blamesInputs ? REJECTED_MAY_NOT_BE_FINAL : undefined,
      )
    }
    readStatus = true // already known: treat as submitted and read its status
  }

  if (!readStatus) {
    // No response, backpressure (503), rate limit or a server error: nothing to read; re-posting is safe.
    const txStatus = postStatus === 0 || postStatus === 503 ? 'UNREACHABLE' : 'UNKNOWN'
    const info = postStatus === 0 ? 'no response from Arcade (network error or timeout)' : errorText(body)
    return finish({ ...base, txStatus, verdict: 'pending', transient, ...extra(info) })
  }

  // A 2xx (or already-known) is provisional; the truth is GET /tx/{txid}.
  if (txid === '') {
    return finish({ ...base, txStatus: 'UNKNOWN', verdict: 'pending', transient: false }, 'could not determine the txid to re-read status; call arcade_status')
  }
  let s: TransactionStatus | { notFound: true }
  try {
    s = waitForSeen ? await client.waitForSeen(txid, timeoutMs) : await client.status(txid)
  } catch (e) {
    const what = typeof body?.txStatus === 'string' && TX_STATUSES.has(body.txStatus) ? ` (POST said ${body.txStatus})` : ''
    return finish(
      { ...base, txStatus: 'UNKNOWN', verdict: 'pending', transient: false },
      `status re-read failed${what}: ${(e as Error).message}; call arcade_status`,
    )
  }
  if ('notFound' in s) {
    return finish({ ...base, txStatus: 'UNKNOWN', verdict: 'pending', transient: false }, `Arcade answered ${postStatus} to POST /tx but GET /tx/${txid} answered 404; call arcade_status`)
  }
  const verdict = verdictOf(s)
  const code = arcCode ?? (verdict === 'terminal' && typeof s.status === 'number' ? s.status : undefined)
  return finish(
    {
      ...base,
      txStatus: s.txStatus,
      verdict,
      competingTxs: s.competingTxs ?? [],
      ...extra(s.extraInfo),
      ...(code === undefined ? {} : { arcCode: code }),
      transient: false,
    },
    rejectedMayNotBeFinal(s) ? REJECTED_MAY_NOT_BE_FINAL : undefined,
  )
}

function extra(extraInfo: string | undefined): { extraInfo?: string } {
  return extraInfo === undefined || extraInfo === '' ? {} : { extraInfo }
}

// Reads never broadcast, so they skip the network/host cross-check: any Arcade can be asked about any txid.
function readClient(input: UrlInput, cfg: Config, fetchImpl: typeof fetch): ArcadeClient {
  const arcadeUrl = input.arcadeUrl === undefined || input.arcadeUrl === '' ? cfg.arcadeUrl : input.arcadeUrl
  return new ArcadeClient({ baseUrl: arcadeUrl, fetchImpl })
}

export async function arcadeStatus(input: StatusInput, cfg: Config, fetchImpl: typeof fetch): Promise<StatusResult> {
  const s = await readClient(input, cfg, fetchImpl).status(input.txid, input.callbackToken)
  if ('notFound' in s) {
    return {
      txid: input.txid.toLowerCase(),
      txStatus: 'UNKNOWN',
      timestamp: new Date().toISOString(),
      verdict: 'no-verdict',
      isFinalForApp: false,
      rawTxPresent: false,
      note: NEVER_GIVEN,
    }
  }
  const verdict = verdictOf(s)
  const rawTxPresent = typeof s.rawTx === 'string' && s.rawTx !== ''
  const rawTxFormat = rawTxPresent ? (detectHexFormat(s.rawTx!) === 'ef' ? 'ef' : 'raw') : undefined
  const note = joinNotes(rejectedMayNotBeFinal(s) ? REJECTED_MAY_NOT_BE_FINAL : undefined, rawTxFormat === 'ef' ? EF_REMINDER : undefined)
  return {
    ...s,
    verdict,
    isFinalForApp: verdict === 'seen-no-competitor',
    rawTxPresent,
    ...(rawTxFormat === undefined ? {} : { rawTxFormat }),
    ...(note === undefined ? {} : { note }),
  }
}

export function arcadePolicy(input: UrlInput, cfg: Config, fetchImpl: typeof fetch): Promise<{ policy: any; timestamp: string; satPerKb: number }> {
  return readClient(input, cfg, fetchImpl).policy()
}

export function arcadeHealth(input: UrlInput, cfg: Config, fetchImpl: typeof fetch): Promise<any> {
  return readClient(input, cfg, fetchImpl).health()
}

const arcadeUrl = z.string().url().optional().describe('Arcade base URL; defaults to ARCADE_URL or the network default')

export function registerArcadeTools(server: McpServer, cfg: Config, fetchImpl: typeof fetch): void {
  server.registerTool(
    'arcade_submit',
    {
      description:
        'Broadcast a raw or EF transaction hex to Arcade (POST /tx; BEEF is refused). A 2xx is provisional: the tool re-reads ' +
        'GET /tx/{txid} and, with waitForSeen, polls until SEEN_ON_NETWORK or later with no competing tx, or timeoutMs. ' +
        'Mainnet broadcast needs BSV_MCP_ALLOW_MAINNET_BROADCAST=1.',
      inputSchema: {
        hex: z.string().describe('Raw or EF transaction hex (not BEEF)'),
        arcadeUrl,
        network: z.enum(['testnet', 'mainnet']).optional().describe('Defaults to BSV_NETWORK'),
        waitForSeen: z.boolean().default(true).describe('Poll status until seen with no competitor, or timeoutMs'),
        timeoutMs: z.number().int().default(15000).describe('How long to wait for seen'),
        callbackUrl: z.string().url().optional().describe('Sent as X-CallbackUrl'),
        callbackToken: z.string().optional().describe('Sent as X-CallbackToken'),
        fullStatusUpdates: z.boolean().optional().describe('Sent as X-FullStatusUpdates'),
      },
    },
    (input) => respond(() => arcadeSubmit(input, cfg, fetchImpl)),
  )

  server.registerTool(
    'arcade_status',
    {
      description:
        'Read GET /tx/{txid} from Arcade with a verdict. isFinalForApp is true at SEEN_ON_NETWORK or later with no competing tx ' +
        '(never wait for MINED). A 404 means this Arcade was never given the txid: no verdict, not rejected.',
      inputSchema: {
        txid: z.string().regex(/^[0-9a-f]{64}$/i).describe('Transaction id (64 hex characters)'),
        arcadeUrl,
        callbackToken: z.string().optional().describe('Callback token the tx was submitted with'),
      },
    },
    (input) => respond(() => arcadeStatus(input, cfg, fetchImpl)),
  )

  server.registerTool(
    'arcade_policy',
    { description: 'Read GET /policy from Arcade, with the mining fee as satPerKb.', inputSchema: { arcadeUrl } },
    (input) => respond(() => arcadePolicy(input, cfg, fetchImpl)),
  )

  server.registerTool(
    'arcade_health',
    { description: 'Read GET /health from Arcade (version, block height, upstream nodes).', inputSchema: { arcadeUrl } },
    (input) => respond(() => arcadeHealth(input, cfg, fetchImpl)),
  )
}

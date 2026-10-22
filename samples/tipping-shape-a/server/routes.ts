import express from 'express'
import { REJECTED_MAY_NOT_BE_FINAL, type Arcade, type Outcome } from './arcade.js'
import { claimMessage, internalizedMessage, isIdentityKey, verifyCreatorSignature } from './auth.js'
import { efHexFromAtomicBeef, outputPaysScript } from './beef.js'
import type { ServerConfig } from './config.js'
import type { Db, Remittance, TipRow } from './db.js'
import { RateLimiter } from './rate-limit.js'
import type { Broadcaster } from './sse.js'

export interface Limits {
  /** POST /api/tips per client address: burst, then refilled per minute. */
  tipBurst: number
  tipsPerMinute: number
  /** Remittance candidates stored per txid. */
  remittancesPerTip: number
  /** Tips kept; above this the oldest that are not seen-no-competitor are deleted. */
  maxTips: number
  /** terminal tips are deleted after this long without an update. */
  terminalMaxAgeMs: number
  /** A status read within this long of the last live read answers from the store. */
  statusFreshMs: number
}

export const DEFAULT_LIMITS: Limits = {
  tipBurst: 5,
  tipsPerMinute: 10,
  remittancesPerTip: 16,
  maxTips: 5000,
  terminalMaxAgeMs: 24 * 60 * 60 * 1000,
  statusFreshMs: 2000,
}

export interface ApiDeps {
  db: Db
  arcade: Arcade
  broadcaster: Broadcaster
  limits?: Partial<Limits>
  /** The clock (ms) for rate limits, pruning and status freshness. Default Date.now. */
  now?: () => number
}

// A tip's AtomicBEEF carries its unproven ancestors, so allow some room, but no more.
const BODY_LIMIT = '1mb'
// How long POST /api/tips waits for SEEN_ON_NETWORK before answering with the status it has.
const SEEN_WAIT_MS = 15_000
const CREATOR_SETTING = 'creatorIdentityKey'

const TXID = /^[0-9a-f]{64}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_DERIVATION_LENGTH = 256

class BadRequest extends Error {}

type Candidate = Omit<Remittance, 'receivedAt'>

interface PostedTip {
  txid: string
  beefHex: string
  efHex: string
  remittance: Candidate
}

function base64Field(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_DERIVATION_LENGTH || !BASE64.test(value)) {
    throw new BadRequest(`remittance.${name} must be non-empty base64`)
  }
  return value
}

/** Validates a POST /api/tips body against the BEEF it carries. Throws BadRequest. */
function parseTip(body: any): PostedTip {
  if (typeof body !== 'object' || body === null) throw new BadRequest('expected a JSON object')
  const { txid, beef, outputIndex, satoshis, remittance } = body
  if (typeof txid !== 'string' || !TXID.test(txid)) throw new BadRequest('txid must be 64 hex characters')
  if (typeof beef !== 'string' || beef === '') throw new BadRequest('beef must be AtomicBEEF hex')
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) throw new BadRequest('outputIndex must be a non-negative integer')
  if (!Number.isSafeInteger(satoshis) || satoshis < 1) throw new BadRequest('satoshis must be a positive integer')
  if (typeof remittance !== 'object' || remittance === null) throw new BadRequest('remittance is required')
  const { senderIdentityKey } = remittance
  if (!isIdentityKey(senderIdentityKey)) throw new BadRequest('remittance.senderIdentityKey must be a compressed public key (66 hex characters)')
  const derivationPrefix = base64Field(remittance.derivationPrefix, 'derivationPrefix')
  const derivationSuffix = base64Field(remittance.derivationSuffix, 'derivationSuffix')

  let efHex: string
  let output: { satoshis: number }
  try {
    efHex = efHexFromAtomicBeef(beef, txid)
    output = outputPaysScript(beef, outputIndex)
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e))
  }
  if (output.satoshis !== satoshis) throw new BadRequest(`satoshis ${satoshis} does not match output ${outputIndex} (${output.satoshis})`)
  return {
    txid: txid.toLowerCase(),
    beefHex: beef.toLowerCase(),
    efHex,
    remittance: { outputIndex, satoshis, senderIdentityKey: senderIdentityKey.toLowerCase(), derivationPrefix, derivationSuffix },
  }
}

/** No repeat POST needs to talk to Arcade: seen with no competitor, or a REJECTED that is final. */
const settled = (row: TipRow) =>
  row.verdict === 'seen-no-competitor' || (row.verdict === 'terminal' && row.note !== REJECTED_MAY_NOT_BE_FINAL)

function statusView(row: TipRow) {
  const { txid, txStatus, verdict, competingTxs, extraInfo, note, updatedAt } = row
  return { txid, txStatus, verdict, competingTxs, extraInfo, note, updatedAt }
}

type Reply = { code: number; body: object }

// The :txid of a route, already checked by api.param.
const txidOf = (req: express.Request) => String(req.params.txid).toLowerCase()

/**
 * The relay API. It holds no key and decides nothing about money: Arcade's verdict says a transaction was seen on
 * the network; only the creator's wallet (a forSelf match on a remittance, then internalizeAction) says a tip
 * was received.
 */
export function mountApi(app: express.Express, cfg: ServerConfig, deps: ApiDeps): void {
  const { db, arcade, broadcaster } = deps
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const tipLimiter = new RateLimiter(limits.tipBurst, limits.tipsPerMinute)
  // One Arcade submission per txid at a time, and one status read per txid at a time.
  const broadcasts = new Map<string, Promise<Outcome>>()
  const statusReads = new Map<string, Promise<Reply>>()
  const lastRead = new Map<string, number>()

  const creator = (): string | undefined => cfg.creatorIdentityKey ?? db.getSetting(CREATOR_SETTING)

  /** Stores an Arcade outcome and emits 'status' when it changed the row. Undefined if the tip was pruned meanwhile. */
  function store(txid: string, o: Outcome): TipRow | undefined {
    const before = db.getTip(txid)
    if (before === undefined) return undefined
    const changed =
      before.txStatus !== o.txStatus ||
      before.verdict !== o.verdict ||
      JSON.stringify(before.competingTxs) !== JSON.stringify(o.competingTxs) ||
      before.extraInfo !== o.extraInfo ||
      before.note !== o.note
    if (!changed) return before
    db.updateStatus(txid, o)
    const row = db.getTip(txid)!
    broadcaster.emit('status', statusView(row))
    return row
  }

  function submitOnce(txid: string, efHex: string): Promise<Outcome> {
    let pending = broadcasts.get(txid)
    if (pending === undefined) {
      pending = arcade
        .broadcast(efHex, txid, SEEN_WAIT_MS)
        .then(o => (store(txid, o), o))
        .finally(() => broadcasts.delete(txid))
      broadcasts.set(txid, pending)
    }
    return pending
  }

  async function readStatus(txid: string): Promise<Reply> {
    let o: Outcome | undefined
    try {
      o = await arcade.read(txid)
      // Arcade has no record (its first submit never got through): submit the stored EF again, then read once.
      if (o === undefined) {
        const beef = db.getBeef(txid)
        if (beef === undefined) return { code: 404, body: { error: 'no tip with this txid' } }
        o = await arcade.broadcast(efHexFromAtomicBeef(beef, txid), txid, 0)
      }
    } catch (e) {
      return { code: 502, body: { transient: true, error: `Arcade status read failed: ${e instanceof Error ? e.message : String(e)}` } }
    }
    if (o.transient) return { code: 502, body: { transient: true, error: o.note ?? 'Arcade did not take the transaction; retry' } }
    const at = now()
    if (lastRead.size > 1000) for (const [k, t] of lastRead) if (at - t >= limits.statusFreshMs) lastRead.delete(k)
    lastRead.set(txid, at)
    const row = store(txid, o)
    return row === undefined ? { code: 404, body: { error: 'no tip with this txid' } } : { code: 200, body: statusView(row) }
  }

  const api = express.Router()
  api.use(express.json({ limit: BODY_LIMIT }))

  api.get('/config', (_req, res) => {
    res.json({ network: cfg.network, creatorIdentityKey: creator(), originator: cfg.publicOrigin, arcadeUrl: cfg.arcadeUrl })
  })

  // The first wallet to claim the creator page becomes the creator, unless CREATOR_IDENTITY_KEY fixes it.
  // The claim carries the key's signature over claim:<identityKey>, so nobody can claim with a key they do not hold.
  api.post('/creator', async (req, res) => {
    const key = req.body?.identityKey
    if (!isIdentityKey(key)) {
      res.status(400).json({ error: 'identityKey must be a compressed public key (66 hex characters)' })
      return
    }
    const identityKey = key.toLowerCase()
    if (!(await verifyCreatorSignature(claimMessage(identityKey), req.body?.signature, identityKey))) {
      res.status(403).json({ error: 'signature must be the identity key signing claim:<identityKey>' })
      return
    }
    const current = creator()
    if (current === undefined) db.setSetting(CREATOR_SETTING, identityKey)
    else if (current !== identityKey) {
      res.status(409).json({ error: 'the creator page is already claimed by another identity key' })
      return
    }
    res.json({ creatorIdentityKey: identityKey })
  })

  api.post('/tips', async (req, res) => {
    const client = req.ip ?? 'unknown'
    if (!tipLimiter.take(client, now())) {
      res.status(429).set('Retry-After', String(tipLimiter.retryAfter(client))).json({ error: 'too many tips from this address; retry shortly' })
      return
    }
    let tip: PostedTip
    try {
      tip = parseTip(req.body)
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      res.status(400).json({ error: e.message })
      return
    }

    let isNew = false
    if (db.getTip(tip.txid) === undefined) {
      db.prune({ now: now(), terminalMaxAgeMs: limits.terminalMaxAgeMs, maxTips: limits.maxTips - 1 })
      isNew = db.insertTip({ txid: tip.txid, beefHex: tip.beefHex, txStatus: 'UNKNOWN', verdict: 'pending', competingTxs: [] }).inserted
    }
    // Anyone who sees the transaction can post it with another remittance, so each distinct one is a candidate.
    const added = db.addRemittance(tip.txid, tip.remittance, limits.remittancesPerTip)
    if (added === 'full') {
      res.status(409).json({ error: `this tip already has ${limits.remittancesPerTip} remittance candidates` })
      return
    }

    let transient = false
    const current = db.getTip(tip.txid)
    if (current !== undefined && !settled(current)) transient = (await submitOnce(tip.txid, tip.efHex)).transient
    const row = db.getTip(tip.txid)
    if (row === undefined) {
      res.status(503).json({ error: 'the relay is at capacity; retry shortly' })
      return
    }
    // A new tip, or a new candidate for one, is something for the creator page to collect.
    if (isNew || added === 'inserted') broadcaster.emit('tip', row)
    // The row stays (verdict pending); the browser retries the POST, which submits again.
    if (transient) res.status(502).json({ ...row, transient: true, error: 'Arcade did not take the transaction; retry' })
    else res.json(row)
  })

  api.get('/tips', (_req, res) => {
    res.json(db.listTips(100))
  })

  // Every route below names one stored tip.
  api.param('txid', (req, res, next, txid: string) => {
    if (!TXID.test(txid)) {
      res.status(400).json({ error: 'txid must be 64 hex characters' })
      return
    }
    if (db.getTip(txid.toLowerCase()) === undefined) {
      res.status(404).json({ error: 'no tip with this txid' })
      return
    }
    next()
  })

  api.get('/tips/:txid', (req, res) => {
    res.json(db.getTip(txidOf(req)))
  })

  api.get('/tips/:txid/beef', (req, res) => {
    const txid = txidOf(req)
    res.json({ txid, beefHex: db.getBeef(txid) })
  })

  api.get('/tips/:txid/status', async (req, res) => {
    const txid = txidOf(req)
    const at = lastRead.get(txid)
    if (at !== undefined && now() - at < limits.statusFreshMs) {
      res.json(statusView(db.getTip(txid)!))
      return
    }
    let pending = statusReads.get(txid)
    if (pending === undefined) {
      pending = readStatus(txid).finally(() => statusReads.delete(txid))
      statusReads.set(txid, pending)
    }
    const { code, body } = await pending
    res.status(code).json(body)
  })

  // The creator page reports a successful internalizeAction, signed by the creator's identity key.
  api.post('/tips/:txid/internalized', async (req, res) => {
    const txid = txidOf(req)
    const key = creator()
    if (key === undefined) {
      res.status(409).json({ error: 'no creator has claimed this relay yet' })
      return
    }
    if (!(await verifyCreatorSignature(internalizedMessage(txid), req.body?.signature, key))) {
      res.status(403).json({ error: 'signature must be the creator signing internalized:<txid>' })
      return
    }
    db.markInternalized(txid)
    res.json(db.getTip(txid))
  })

  api.get('/events', (_req, res) => {
    broadcaster.add(res)
  })

  api.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  // Body-parser errors (too large, not JSON) and anything a handler threw: JSON, never a stack trace.
  api.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500
    if (status >= 500) console.error('relay error:', err)
    const error = status === 413 ? 'request body too large' : status < 500 ? 'invalid request body' : 'internal error'
    res.status(status).json({ error })
  })

  app.use('/api', api)
}

import { randomBytes } from 'node:crypto'
import express from 'express'
import { REJECTED_MAY_NOT_BE_FINAL, type Arcade, type Outcome } from './arcade.js'
import { claimMessage, internalizedMessage, isIdentityKey, verifyCreatorSignature } from './auth.js'
import { efHexFromAtomicBeef, outputPaysScript, plainHexFromArcadeRawTx } from './beef.js'
import type { ServerConfig } from './config.js'
import type { Db, Remittance, TipRow } from './db.js'
import { addressKey, RateLimiter } from './rate-limit.js'
import type { Broadcaster } from './sse.js'

export interface Limits {
  /** POST /api/tips per client address: burst, then refilled per minute. */
  tipBurst: number
  tipsPerMinute: number
  /** Remittance candidates stored per txid (each with the BEEF it arrived with). */
  remittancesPerTip: number
  /** Tips kept; above this terminal tips, then the oldest that are not seen-no-competitor, are deleted. */
  maxTips: number
  /** terminal tips are deleted after this long without an update. */
  terminalMaxAgeMs: number
  /** A status read within this long of the last live read answers from the store. */
  statusFreshMs: number
  /** All stored BEEFs together (bytes); a POST whose BEEF would exceed it gets 503. */
  beefBytesBudget: number
  /** GET /api/tips/:txid/status, GET /api/tx/:id and POST /api/tips/:txid/rebroadcast per client address: burst, then refilled per minute. */
  readBurst: number
  readsPerMinute: number
}

export const DEFAULT_LIMITS: Limits = {
  tipBurst: 5,
  tipsPerMinute: 10,
  remittancesPerTip: 64,
  maxTips: 5000,
  terminalMaxAgeMs: 24 * 60 * 60 * 1000,
  statusFreshMs: 2000,
  // 256 MiB: some 2,000 of the largest BEEFs a POST may carry, far more than ordinary tips need.
  beefBytesBudget: 256 * 1024 * 1024,
  readBurst: 30,
  readsPerMinute: 120,
}

export interface ApiDeps {
  db: Db
  arcade: Arcade
  broadcaster: Broadcaster
  limits?: Partial<Limits>
  /** The clock (ms) for rate limits, pruning and status freshness. Default Date.now. */
  now?: () => number
}

// A tip's AtomicBEEF carries its unproven ancestors and their proofs: a little room, no more. Every candidate
// stores its own BEEF, so this also bounds what one POST can make the relay keep.
const BODY_LIMIT = '256kb'
// How long POST /api/tips waits for SEEN_ON_NETWORK before answering with the status it has.
const SEEN_WAIT_MS = 15_000
const CREATOR_SETTING = 'creatorIdentityKey'
const CLAIM_NONCE_SETTING = 'claimNonce'

const TXID = /^[0-9a-f]{64}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_DERIVATION_LENGTH = 256

class BadRequest extends Error {}

type Candidate = Omit<Remittance, 'receivedAt' | 'beefId'>

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
  const readLimiter = new RateLimiter(limits.readBurst, limits.readsPerMinute)
  // One Arcade submission per txid at a time, and one status read per txid at a time.
  const broadcasts = new Map<string, Promise<Outcome>>()
  const statusReads = new Map<string, Promise<Reply>>()
  const ancestorReads = new Map<string, Promise<Reply>>()
  const lastRead = new Map<string, number>()

  const creator = (): string | undefined => cfg.creatorIdentityKey ?? db.getSetting(CREATOR_SETTING)
  const newClaimNonce = () => {
    const nonce = randomBytes(16).toString('hex')
    db.setSetting(CLAIM_NONCE_SETTING, nonce)
    return nonce
  }
  const claimNonce = () => db.getSetting(CLAIM_NONCE_SETTING) ?? newClaimNonce()

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
      // A transient outcome (Arcade unreachable, 5xx, 429) says nothing about the transaction: keep what is stored.
      pending = arcade
        .broadcast(efHex, txid, SEEN_WAIT_MS)
        .then(o => (o.transient || store(txid, o), o))
        .finally(() => broadcasts.delete(txid))
      broadcasts.set(txid, pending)
    }
    return pending
  }

  /** Arcade's view of a stored tip. `repost`: submit the stored EF again first (the second read of the two-read rule). */
  async function readStatus(txid: string, repost = false): Promise<Reply> {
    let o: Outcome | undefined
    try {
      if (repost) {
        const beef = db.getBeef(txid)
        if (beef === undefined) return { code: 404, body: { error: 'no tip with this txid' } }
        o = await arcade.broadcast(efHexFromAtomicBeef(beef, txid), txid, 0)
      } else o = await arcade.read(txid)
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

  /** An ancestor transaction from Arcade, re-read as plain hex, with its merkle path when Arcade has one. */
  async function readAncestor(txid: string): Promise<Reply> {
    let s: Awaited<ReturnType<Arcade['status']>>
    try {
      s = await arcade.status(txid)
    } catch (e) {
      return { code: 502, body: { transient: true, error: `Arcade status read failed: ${e instanceof Error ? e.message : String(e)}` } }
    }
    if ('notFound' in s) return { code: 404, body: { error: 'Arcade has no record of this txid' } }
    if (typeof s.rawTx !== 'string' || s.rawTx === '') return { code: 404, body: { error: 'Arcade holds no rawTx for this txid' } }
    let rawTx: string
    try {
      rawTx = plainHexFromArcadeRawTx(s.rawTx, txid)
    } catch (e) {
      return { code: 502, body: { error: e instanceof Error ? e.message : String(e) } }
    }
    const body: { txid: string; rawTx: string; merklePath?: string } = { txid, rawTx }
    if (typeof s.merklePath === 'string' && s.merklePath !== '') body.merklePath = s.merklePath
    return { code: 200, body }
  }

  /** One in-flight read per key; answers every caller with its reply. */
  function coalesced(map: Map<string, Promise<Reply>>, key: string, read: () => Promise<Reply>): Promise<Reply> {
    let pending = map.get(key)
    if (pending === undefined) {
      pending = read().finally(() => map.delete(key))
      map.set(key, pending)
    }
    return pending
  }

  /** False (and a 429 sent) when this client is over the read limit. */
  function readAllowed(req: express.Request, res: express.Response): boolean {
    const client = addressKey(req.ip)
    if (readLimiter.take(client, now())) return true
    res.status(429).set('Retry-After', String(readLimiter.retryAfter(client))).json({ error: 'too many reads from this address; retry shortly' })
    return false
  }

  const api = express.Router()
  api.use(express.json({ limit: BODY_LIMIT }))

  api.get('/config', (_req, res) => {
    res.json({
      network: cfg.network,
      creatorIdentityKey: creator(),
      originator: cfg.publicOrigin,
      claimNonce: claimNonce(),
    })
  })

  // The first wallet to claim the creator page becomes the creator, unless CREATOR_IDENTITY_KEY fixes it. The claim
  // carries the key's signature over claim:<origin>:<identityKey>:<claimNonce>, so nobody can claim with a key they
  // do not hold, and the signature is good for this relay and this nonce only.
  api.post('/creator', async (req, res) => {
    const key = req.body?.identityKey
    if (!isIdentityKey(key)) {
      res.status(400).json({ error: 'identityKey must be a compressed public key (66 hex characters)' })
      return
    }
    const identityKey = key.toLowerCase()
    if (!(await verifyCreatorSignature(claimMessage(cfg.publicOrigin, identityKey, claimNonce()), req.body?.signature, identityKey))) {
      res.status(403).json({ error: 'signature must be the identity key signing claim:<origin>:<identityKey>:<claimNonce>' })
      return
    }
    const current = creator()
    if (current === undefined) {
      db.setSetting(CREATOR_SETTING, identityKey)
      newClaimNonce() // this signature is spent
    } else if (current !== identityKey) {
      res.status(409).json({ error: 'the creator page is already claimed by another identity key' })
      return
    }
    res.json({ creatorIdentityKey: identityKey })
  })

  api.post('/tips', async (req, res) => {
    const client = addressKey(req.ip)
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

    const known = db.getTip(tip.txid) !== undefined
    if (!known) db.prune({ now: now(), terminalMaxAgeMs: limits.terminalMaxAgeMs, maxTips: limits.maxTips - 1 })
    // Checked before anything is stored, so a refused POST leaves no tip without a candidate.
    if (!db.beefFits(tip.beefHex, limits.beefBytesBudget)) {
      res.status(503).set('Retry-After', '300').json({ error: 'the relay\'s BEEF storage is full; retry later' })
      return
    }
    const isNew = !known && db.insertTip({ txid: tip.txid, txStatus: 'UNKNOWN', verdict: 'pending', competingTxs: [] }).inserted
    // Anyone who sees the transaction can post it with another remittance or another BEEF, so each distinct
    // remittance is a candidate that keeps the BEEF it came with.
    const added = db.addRemittance(tip.txid, tip.remittance, tip.beefHex, limits.remittancesPerTip)
    if (added === 'full') {
      res.status(409).json({ error: `this tip already has ${limits.remittancesPerTip} remittance candidates` })
      return
    }

    let outcome: Outcome | undefined
    const current = db.getTip(tip.txid)
    if (current !== undefined && !settled(current)) outcome = await submitOnce(tip.txid, tip.efHex)
    const row = db.getTip(tip.txid)
    if (row === undefined) {
      res.status(503).json({ error: 'the relay is at capacity; retry shortly' })
      return
    }
    // A new tip, or a new candidate for one, is something for the creator page to collect.
    if (isNew || added === 'inserted') broadcaster.emit('tip', row)
    // The stored row is unchanged (verdict pending for a new tip); the browser retries the POST, which submits again.
    if (outcome?.transient) {
      res.status(502).json({ ...row, transient: true, error: `Arcade did not take the transaction (${outcome.txStatus}): ${outcome.note ?? 'retry'}` })
    }
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

  // The BEEF a candidate arrived with (its remittance's beefId): the creator internalizes the candidate it matched
  // with that candidate's own BEEF, never another poster's.
  api.get('/tips/:txid/beef', (req, res) => {
    const txid = txidOf(req)
    const id = req.query.id
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id)) {
      res.status(400).json({ error: 'id must be the beefId (64 hex characters) of one of this tip\'s remittances' })
      return
    }
    const beefHex = db.getBeef(txid, id.toLowerCase())
    if (beefHex === undefined) {
      res.status(404).json({ error: 'no remittance of this tip has that beefId' })
      return
    }
    res.json({ txid, beefId: id.toLowerCase(), beefHex })
  })

  api.get('/tips/:txid/status', async (req, res) => {
    if (!readAllowed(req, res)) return
    const txid = txidOf(req)
    const at = lastRead.get(txid)
    if (at !== undefined && now() - at < limits.statusFreshMs) {
      res.json(statusView(db.getTip(txid)!))
      return
    }
    const { code, body } = await coalesced(statusReads, txid, () => readStatus(txid))
    res.status(code).json(body)
  })

  // The two-read dead rule's re-post: submit the stored EF to Arcade again, then read its status.
  api.post('/tips/:txid/rebroadcast', async (req, res) => {
    if (!readAllowed(req, res)) return
    const txid = txidOf(req)
    const { code, body } = await coalesced(statusReads, `repost:${txid}`, () => readStatus(txid, true))
    res.status(code).json(body)
  })

  // An ancestor a tip's BEEF names by txid only, for the creator page to complete the BEEF: Arcade is the source
  // for a known txid, and the browser asks this origin rather than Arcade (no CORS, no private ARCADE_URL).
  // `:id`, not `:txid`: the transaction need not be a stored tip.
  api.get('/tx/:id', async (req, res) => {
    const txid = String(req.params.id).toLowerCase()
    if (!TXID.test(txid)) {
      res.status(400).json({ error: 'txid must be 64 hex characters' })
      return
    }
    if (!readAllowed(req, res)) return
    const { code, body } = await coalesced(ancestorReads, txid, () => readAncestor(txid))
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
    if (!(await verifyCreatorSignature(internalizedMessage(cfg.publicOrigin, txid), req.body?.signature, key))) {
      res.status(403).json({ error: 'signature must be the creator signing internalized:<origin>:<txid>' })
      return
    }
    db.markInternalized(txid)
    res.json(db.getTip(txid))
  })

  api.get('/events', (req, res) => {
    broadcaster.add(res, addressKey(req.ip))
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

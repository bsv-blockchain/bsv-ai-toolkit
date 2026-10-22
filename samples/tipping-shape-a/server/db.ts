import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

// The relay's store. A tip is one transaction (keyed by txid) with Arcade's view of it; the remittances that
// tippers posted for it are candidates, because anyone who sees the transaction can post it with a different
// remittance, or with the same transaction wrapped in a different BEEF (the relay checks a BEEF's structure, not
// its merkle proofs). So each candidate keeps the BEEF it arrived with, and the creator's wallet tries each
// candidate (forSelf) and internalizes the one that is its own, with that candidate's BEEF.
// Every statement is prepared with parameters; no value is ever spliced into SQL.

export interface Remittance {
  /** sha256 (hex) of the BEEF bytes this candidate arrived with; GET /api/tips/:txid/beef?id=<beefId>. */
  beefId: string
  outputIndex: number
  satoshis: number
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  receivedAt: string
}

export interface TipRow {
  txid: string
  /** Arcade's txStatus, or UNREACHABLE when Arcade could not be reached. */
  txStatus: string
  verdict: string
  competingTxs: string[]
  extraInfo?: string
  /** A caveat on the verdict (e.g. a REJECTED that may not be final, or an Arcade answer that is not a verdict). */
  note?: string
  receivedAt: string
  updatedAt: string
  internalizedAt?: string
  /** Candidates in the order they arrived. */
  remittances: Remittance[]
}

export interface TipStatus {
  txStatus: string
  verdict: string
  competingTxs: string[]
  extraInfo?: string
  note?: string
}

export interface NewTip extends TipStatus {
  txid: string
}

export interface PruneOptions {
  now: number
  /** terminal tips not updated for this long are deleted */
  terminalMaxAgeMs: number
  /** above this many tips, terminal tips and then the oldest that are not seen-no-competitor are deleted */
  maxTips: number
}

export interface Db {
  insertTip(tip: NewTip): { inserted: boolean }
  /**
   * Adds a candidate with the AtomicBEEF hex it arrived with, unless it is already stored ('exists', keeping its
   * first BEEF) or the tip has `maxPerTip` candidates ('full').
   */
  addRemittance(txid: string, r: Omit<Remittance, 'receivedAt' | 'beefId'>, beefHex: string, maxPerTip: number): 'inserted' | 'exists' | 'full'
  getTip(txid: string): TipRow | undefined
  /** The BEEF of one of this tip's candidates (by beefId), or of its first candidate when beefId is omitted. */
  getBeef(txid: string, beefId?: string): string | undefined
  listTips(limit?: number): TipRow[]
  updateStatus(txid: string, s: TipStatus): void
  markInternalized(txid: string): void
  /**
   * Deletes old terminal tips, then (above the cap) terminal tips and then the oldest unseen tips, and any BEEF no
   * candidate uses any more. Returns how many tips it deleted.
   */
  prune(opts: PruneOptions): number
  /**
   * True when storing this BEEF keeps the stored BEEF bytes within `budgetBytes` (a BEEF already stored costs
   * nothing: it is kept once).
   */
  beefFits(beefHex: string, budgetBytes: number): boolean
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tips (
  txid TEXT PRIMARY KEY,
  tx_status TEXT NOT NULL,
  verdict TEXT NOT NULL,
  competing_json TEXT NOT NULL DEFAULT '[]',
  extra_info TEXT,
  note TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  internalized_at TEXT
);
CREATE INDEX IF NOT EXISTS tips_received ON tips (received_at);
CREATE INDEX IF NOT EXISTS tips_verdict_updated ON tips (verdict, updated_at);
-- size (bytes) comes before beef_hex so summing it never reads the BEEF's overflow pages.
CREATE TABLE IF NOT EXISTS beefs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, beef_hex TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS remittances (
  txid TEXT NOT NULL REFERENCES tips (txid) ON DELETE CASCADE,
  beef_sha256 TEXT NOT NULL REFERENCES beefs (sha256),
  output_index INTEGER NOT NULL,
  sender_identity_key TEXT NOT NULL,
  derivation_prefix TEXT NOT NULL,
  derivation_suffix TEXT NOT NULL,
  satoshis INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (txid, output_index, sender_identity_key, derivation_prefix, derivation_suffix)
);
CREATE INDEX IF NOT EXISTS remittances_beef ON remittances (beef_sha256);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

interface RawTip {
  txid: string
  tx_status: string
  verdict: string
  competing_json: string
  extra_info: string | null
  note: string | null
  received_at: string
  updated_at: string
  internalized_at: string | null
}

interface RawRemittance {
  beef_sha256: string
  output_index: number
  satoshis: number
  sender_identity_key: string
  derivation_prefix: string
  derivation_suffix: string
  received_at: string
}

/**
 * The schema's version, stamped in PRAGMA user_version. Nothing migrates: a file of another version (or one from
 * before versioning) is refused at boot, and the developer deletes it.
 */
export const SCHEMA_VERSION = 1

const TIP_COLUMNS = 'txid, tx_status, verdict, competing_json, extra_info, note, received_at, updated_at, internalized_at'

/** Opens (creating if needed) the SQLite file; ':memory:' for tests. WAL mode so reads never block the writer. */
export function openDb(file: string): Db {
  const db = new Database(file)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.transaction(() => {
      const version = db.pragma('user_version', { simple: true }) as number
      const tables = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()!.n
      if (version === 0 && tables === 0) {
        db.exec(SCHEMA)
        db.pragma(`user_version = ${SCHEMA_VERSION}`)
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `${file} has schema version ${version}; this relay needs ${SCHEMA_VERSION}. It is a database from an older ` +
            `build and nothing migrates it: delete ${file} (and its -wal and -shm files), then start again.`,
        )
      }
    })()
  } catch (e) {
    db.close()
    throw e
  }

  const insertTip = db.prepare(`
    INSERT INTO tips (txid, tx_status, verdict, competing_json, extra_info, note, received_at, updated_at)
    VALUES (@txid, @txStatus, @verdict, @competingJson, @extraInfo, @note, @now, @now)
    ON CONFLICT(txid) DO NOTHING`)
  const insertBeef = db.prepare('INSERT INTO beefs (sha256, size, beef_hex) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
  const beefStored = db.prepare<[string], { one: number }>('SELECT 1 AS one FROM beefs WHERE sha256 = ?')
  const beefBytes = db.prepare<[], { n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM beefs')
  const insertRemittance = db.prepare(`
    INSERT INTO remittances (txid, beef_sha256, output_index, sender_identity_key, derivation_prefix, derivation_suffix, satoshis, received_at)
    VALUES (@txid, @beefId, @outputIndex, @senderIdentityKey, @derivationPrefix, @derivationSuffix, @satoshis, @now)
    ON CONFLICT DO NOTHING`)
  const remittanceExists = db.prepare<[string, number, string, string, string], { one: number }>(`
    SELECT 1 AS one FROM remittances
    WHERE txid = ? AND output_index = ? AND sender_identity_key = ? AND derivation_prefix = ? AND derivation_suffix = ?`)
  const countRemittances = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM remittances WHERE txid = ?')
  const remittancesOf = db.prepare<[string], RawRemittance>(
    'SELECT * FROM remittances WHERE txid = ? ORDER BY received_at, rowid',
  )
  const getTip = db.prepare<[string], RawTip>(`SELECT ${TIP_COLUMNS} FROM tips WHERE txid = ?`)
  const getBeef = db.prepare<[string, string], { beef_hex: string }>(`
    SELECT b.beef_hex FROM remittances r JOIN beefs b ON b.sha256 = r.beef_sha256 WHERE r.txid = ? AND r.beef_sha256 = ? LIMIT 1`)
  const getFirstBeef = db.prepare<[string], { beef_hex: string }>(`
    SELECT b.beef_hex FROM remittances r JOIN beefs b ON b.sha256 = r.beef_sha256 WHERE r.txid = ? ORDER BY r.received_at, r.rowid LIMIT 1`)
  // rowid breaks ties between tips received in the same millisecond.
  const listTips = db.prepare<[number], RawTip>(`SELECT ${TIP_COLUMNS} FROM tips ORDER BY received_at DESC, rowid DESC LIMIT ?`)
  const update = db.prepare(`
    UPDATE tips SET tx_status = @txStatus, verdict = @verdict, competing_json = @competingJson, extra_info = @extraInfo,
                    note = @note, updated_at = @now
    WHERE txid = @txid`)
  const internalized = db.prepare('UPDATE tips SET internalized_at = COALESCE(internalized_at, @now), updated_at = @now WHERE txid = @txid')
  const pruneTerminal = db.prepare("DELETE FROM tips WHERE verdict = 'terminal' AND updated_at < ?")
  const countTips = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tips')
  // Terminal tips go first, then the oldest of the rest; a tip seen with no competitor is never evicted.
  const pruneOldest = db.prepare(`
    DELETE FROM tips WHERE rowid IN (
      SELECT rowid FROM tips WHERE verdict != 'seen-no-competitor'
      ORDER BY CASE verdict WHEN 'terminal' THEN 0 ELSE 1 END, received_at, rowid LIMIT ?)`)
  const pruneBeefs = db.prepare('DELETE FROM beefs WHERE sha256 NOT IN (SELECT beef_sha256 FROM remittances)')
  const getSetting = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  const now = () => new Date().toISOString()
  const beefIdOf = (beefHex: string) => createHash('sha256').update(Buffer.from(beefHex, 'hex')).digest('hex')

  function toRow(r: RawTip): TipRow {
    const row: TipRow = {
      txid: r.txid,
      txStatus: r.tx_status,
      verdict: r.verdict,
      competingTxs: JSON.parse(r.competing_json) as string[],
      receivedAt: r.received_at,
      updatedAt: r.updated_at,
      remittances: remittancesOf.all(r.txid).map(m => ({
        beefId: m.beef_sha256,
        outputIndex: m.output_index,
        satoshis: m.satoshis,
        senderIdentityKey: m.sender_identity_key,
        derivationPrefix: m.derivation_prefix,
        derivationSuffix: m.derivation_suffix,
        receivedAt: m.received_at,
      })),
    }
    if (r.extra_info !== null) row.extraInfo = r.extra_info
    if (r.note !== null) row.note = r.note
    if (r.internalized_at !== null) row.internalizedAt = r.internalized_at
    return row
  }

  // Count and insert in one transaction, so the cap holds.
  const addRemittance = db.transaction(
    (txid: string, r: Omit<Remittance, 'receivedAt' | 'beefId'>, beefHex: string, maxPerTip: number) => {
      if (remittanceExists.get(txid, r.outputIndex, r.senderIdentityKey, r.derivationPrefix, r.derivationSuffix)) return 'exists' as const
      if (countRemittances.get(txid)!.n >= maxPerTip) return 'full' as const
      const beefId = beefIdOf(beefHex)
      insertBeef.run(beefId, beefHex.length / 2, beefHex.toLowerCase())
      insertRemittance.run({ txid, beefId, ...r, now: now() })
      return 'inserted' as const
    },
  )

  const prune = db.transaction(({ now: at, terminalMaxAgeMs, maxTips }: PruneOptions) => {
    let deleted = pruneTerminal.run(new Date(at - terminalMaxAgeMs).toISOString()).changes
    const excess = countTips.get()!.n - maxTips
    if (excess > 0) deleted += pruneOldest.run(excess).changes
    if (deleted > 0) pruneBeefs.run()
    return deleted
  })

  return {
    insertTip(tip) {
      const info = insertTip.run({
        txid: tip.txid,
        txStatus: tip.txStatus,
        verdict: tip.verdict,
        competingJson: JSON.stringify(tip.competingTxs),
        extraInfo: tip.extraInfo ?? null,
        note: tip.note ?? null,
        now: now(),
      })
      return { inserted: info.changes === 1 }
    },
    addRemittance: (txid, r, beefHex, maxPerTip) => addRemittance(txid, r, beefHex, maxPerTip),
    getTip(txid) {
      const r = getTip.get(txid)
      return r === undefined ? undefined : toRow(r)
    },
    getBeef(txid, beefId) {
      return (beefId === undefined ? getFirstBeef.get(txid) : getBeef.get(txid, beefId))?.beef_hex
    },
    listTips(limit = 100) {
      return listTips.all(limit).map(toRow)
    },
    updateStatus(txid, s) {
      update.run({
        txid,
        txStatus: s.txStatus,
        verdict: s.verdict,
        competingJson: JSON.stringify(s.competingTxs),
        extraInfo: s.extraInfo ?? null,
        note: s.note ?? null,
        now: now(),
      })
    },
    markInternalized(txid) {
      internalized.run({ txid, now: now() })
    },
    prune: opts => prune(opts),
    beefFits(beefHex, budgetBytes) {
      if (beefStored.get(beefIdOf(beefHex))) return true
      return beefBytes.get()!.n + beefHex.length / 2 <= budgetBytes
    },
    getSetting(key) {
      return getSetting.get(key)?.value
    },
    setSetting(key, value) {
      setSetting.run(key, value)
    },
    close() {
      db.close()
    },
  }
}

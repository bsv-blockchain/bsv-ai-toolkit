import Database from 'better-sqlite3'

// The relay's store: one row per tip, keyed by txid, plus a small settings table (the claimed creator key).
// Every statement is prepared with parameters; no value is ever spliced into SQL.

export interface TipRow {
  txid: string
  /** The AtomicBEEF hex the tipper posted; the creator's wallet internalizes it. */
  beefHex: string
  outputIndex: number
  satoshis: number
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
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
}

export interface TipStatus {
  txStatus: string
  verdict: string
  competingTxs: string[]
  extraInfo?: string
  note?: string
}

export interface Db {
  insertTip(row: Omit<TipRow, 'receivedAt' | 'updatedAt'>): { inserted: boolean }
  getTip(txid: string): TipRow | undefined
  listTips(limit?: number): TipRow[]
  updateStatus(txid: string, s: TipStatus): void
  markInternalized(txid: string): void
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tips (
  txid TEXT PRIMARY KEY,
  beef_hex TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  satoshis INTEGER NOT NULL,
  sender_identity_key TEXT NOT NULL,
  derivation_prefix TEXT NOT NULL,
  derivation_suffix TEXT NOT NULL,
  tx_status TEXT NOT NULL,
  verdict TEXT NOT NULL,
  competing_json TEXT NOT NULL DEFAULT '[]',
  extra_info TEXT,
  note TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  internalized_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

interface Raw {
  txid: string
  beef_hex: string
  output_index: number
  satoshis: number
  sender_identity_key: string
  derivation_prefix: string
  derivation_suffix: string
  tx_status: string
  verdict: string
  competing_json: string
  extra_info: string | null
  note: string | null
  received_at: string
  updated_at: string
  internalized_at: string | null
}

function toRow(r: Raw): TipRow {
  const row: TipRow = {
    txid: r.txid,
    beefHex: r.beef_hex,
    outputIndex: r.output_index,
    satoshis: r.satoshis,
    senderIdentityKey: r.sender_identity_key,
    derivationPrefix: r.derivation_prefix,
    derivationSuffix: r.derivation_suffix,
    txStatus: r.tx_status,
    verdict: r.verdict,
    competingTxs: JSON.parse(r.competing_json) as string[],
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
  }
  if (r.extra_info !== null) row.extraInfo = r.extra_info
  if (r.note !== null) row.note = r.note
  if (r.internalized_at !== null) row.internalizedAt = r.internalized_at
  return row
}

/** Opens (creating if needed) the SQLite file; ':memory:' for tests. WAL mode so reads never block the writer. */
export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  const insert = db.prepare(`
    INSERT INTO tips (txid, beef_hex, output_index, satoshis, sender_identity_key, derivation_prefix, derivation_suffix,
                      tx_status, verdict, competing_json, extra_info, note, received_at, updated_at, internalized_at)
    VALUES (@txid, @beefHex, @outputIndex, @satoshis, @senderIdentityKey, @derivationPrefix, @derivationSuffix,
            @txStatus, @verdict, @competingJson, @extraInfo, @note, @now, @now, @internalizedAt)
    ON CONFLICT(txid) DO NOTHING`)
  const get = db.prepare<[string], Raw>('SELECT * FROM tips WHERE txid = ?')
  // rowid breaks ties between tips received in the same millisecond.
  const list = db.prepare<[number], Raw>('SELECT * FROM tips ORDER BY received_at DESC, rowid DESC LIMIT ?')
  const update = db.prepare(`
    UPDATE tips SET tx_status = @txStatus, verdict = @verdict, competing_json = @competingJson, extra_info = @extraInfo,
                    note = @note, updated_at = @now
    WHERE txid = @txid`)
  const internalized = db.prepare('UPDATE tips SET internalized_at = COALESCE(internalized_at, @now), updated_at = @now WHERE txid = @txid')
  const getSetting = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  const now = () => new Date().toISOString()

  return {
    insertTip(row) {
      const info = insert.run({
        ...row,
        competingJson: JSON.stringify(row.competingTxs),
        extraInfo: row.extraInfo ?? null,
        note: row.note ?? null,
        internalizedAt: row.internalizedAt ?? null,
        now: now(),
      })
      return { inserted: info.changes === 1 }
    },
    getTip(txid) {
      const r = get.get(txid)
      return r === undefined ? undefined : toRow(r)
    },
    listTips(limit = 100) {
      return list.all(limit).map(toRow)
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

import type { TransactionStatus, TxStatus, Verdict } from '../types.js'

// The app gate: SEEN_ON_NETWORK or later, with no competing transaction.
const SEEN: ReadonlySet<TxStatus> = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED', 'STUMP_PROCESSING', 'IMMUTABLE'])
const TERMINAL: ReadonlySet<TxStatus> = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'])
const ON_NETWORK_NOT_SEEN: ReadonlySet<TxStatus> = new Set(['RECEIVED', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK'])
const NON_FINAL: ReadonlySet<TxStatus> = new Set(['UNKNOWN', 'PENDING_RETRY'])

export function verdictOf(s: TransactionStatus): Verdict {
  if (TERMINAL.has(s.txStatus)) return 'terminal'
  if ((s.competingTxs ?? []).length > 0) return 'pending'
  if (SEEN.has(s.txStatus)) return 'seen-no-competitor'
  if (ON_NETWORK_NOT_SEEN.has(s.txStatus)) return 'on-network-not-seen'
  if (NON_FINAL.has(s.txStatus)) return 'pending'
  return 'no-verdict' // a txStatus outside the documented twelve
}

export function detectHexFormat(hex: string): 'beef' | 'ef' | 'raw' {
  if (/^(0100beef|0200beef|01010101)/i.test(hex)) return 'beef'
  if (/^[0-9a-f]{8}0000000000ef/i.test(hex)) return 'ef'
  return 'raw'
}

// Whole tokens only: 'already known' prose or a longer identifier containing the token does not count.
const ALREADY_KNOWN = /(?<![\w-])(TX_EXISTS|txn-already-known)(?![\w-])/

export function classify400(body: { status?: number; error?: string; reason?: string; detail?: string; title?: string }): { kind: 'transient-476' | 'already-known' | 'terminal'; arcCode?: number } {
  const arcCode = typeof body.status === 'number' ? body.status : undefined
  const withCode = <K extends string>(kind: K) => (arcCode === undefined ? { kind } : { kind, arcCode })
  if (arcCode === 476) return withCode('transient-476')
  if ([body.reason, body.detail, body.error].some((v) => typeof v === 'string' && ALREADY_KNOWN.test(v))) return withCode('already-known')
  return withCode('terminal')
}

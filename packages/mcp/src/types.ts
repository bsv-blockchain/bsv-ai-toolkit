export type Network = 'testnet' | 'mainnet'
export type TxStatus = 'UNKNOWN'|'RECEIVED'|'SENT_TO_NETWORK'|'ACCEPTED_BY_NETWORK'|'SEEN_ON_NETWORK'|'SEEN_MULTIPLE_NODES'|'DOUBLE_SPEND_ATTEMPTED'|'REJECTED'|'PENDING_RETRY'|'STUMP_PROCESSING'|'MINED'|'IMMUTABLE'
export interface TransactionStatus { txid: string; txStatus: TxStatus; timestamp: string; status?: number; blockHash?: string; blockHeight?: number; merklePath?: string | null; extraInfo?: string; competingTxs?: string[]; rawTx?: string; retryCount?: number; nextRetryAt?: string }
export type Verdict = 'seen-no-competitor' | 'on-network-not-seen' | 'pending' | 'terminal' | 'no-verdict'
export interface SubmitResult { txid: string; postStatus: number; txStatus: TxStatus | 'UNREACHABLE'; verdict: Verdict; competingTxs: string[]; extraInfo?: string; arcCode?: number; transient: boolean; warning?: string }
export interface StatusResult extends TransactionStatus { verdict: Verdict; isFinalForApp: boolean; rawTxPresent: boolean; rawTxFormat?: 'ef' | 'raw'; note?: string }
export type Severity = 'error' | 'warn'
export interface Finding { id: string; severity: Severity; file: string; line: number; snippet: string; fix: string; ref: string }
export type ShapeDetected = 'A' | 'B' | 'A+B' | 'unknown'
export interface GuardrailReport { shapeDetected: ShapeDetected; findings: Finding[]; passed: string[]; notApplicable: string[]; manualChecklist: string[] }
export interface VersionRow { name: string; pinned: string; latest: string; verifiedOn: string; ageDays: number; drift: boolean; note?: string }

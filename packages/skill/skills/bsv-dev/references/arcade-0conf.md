# Broadcast with Arcade and decide finality at 0-conf

Applies to: both
Guardrails: G-09, G-10, G-11, G-12, G-13, G-14, G-15, G-16

Arcade is the broadcaster and the source of truth for every transaction whose txid you know. The app has its own small Arcade client: it submits with `POST /tx` and gates every money decision on its own `GET /tx/{txid}`. `@bsv/sdk` 3.2.1 has no Arcade broadcaster, and its `ARC` class posts to the legacy ARC API, which Arcade does not serve, so never use it (verified 2026-10-22). The `bsv-mcp` tools `arcade_submit` and `arcade_status` are for development; app code does not call them. Endpoints, status values and ARC codes are in `facts.md` (section "Arcade broadcaster").

`ARCADE_URL` is a setting, defaulting per `BSV_NETWORK`: testnet `https://arcade-testnet-us-1.bsvblockchain.tech`, mainnet `https://arcade-us-1.bsvblockchain.tech` (verified 2026-10-22).

## Submit

```ts
const res = await fetch(`${ARCADE_URL}/tx`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: tx.toHexEF(), // EF when every input carries sourceTransaction; otherwise tx.toHex()
  signal: AbortSignal.timeout(10_000),
})
```

- The body is raw or Extended Format (EF, BRC-30) hex, never BEEF: Arcade rejects BEEF. From a BEEF or an AtomicBEEF, parse it (`Transaction.fromAtomicBEEF(bytes)`) and send `.toHexEF()`.
- Size the fee from the serialized draft at the rate `GET /policy` reports, never from a guessed size.
- A 2xx (`{ txid, status, txStatus }`) is provisional. Arcade can answer 2xx and mark the transaction `REJECTED` about 20 ms later (verified 2026-10-22). Always read `GET /tx/{txid}` afterwards.
- Resubmission is idempotent: posting a known transaction again answers 202 with its current state. Keep the signed hex and re-post freely.

## The single gate

`GET /tx/{txid}` answers 200 with a `TransactionStatus` or 404. The transaction is final for the app when `txStatus` is `SEEN_ON_NETWORK` or later and `competingTxs` is absent or empty. Payments count, goods ship, state moves and payouts are collected at that point.

```ts
const PAST_GATE = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'STUMP_PROCESSING', 'MINED', 'IMMUTABLE']) // MINED counts once reached; never wait for it
function gate(s: TransactionStatus | null): 'final' | 'wait' | 'refused' | 'no-verdict' {
  if (s === null) return 'no-verdict' // 404: this Arcade never saw the txid
  if (s.txStatus === 'REJECTED' || s.txStatus === 'DOUBLE_SPEND_ATTEMPTED') return 'refused'
  if ((s.competingTxs ?? []).length > 0) return 'wait' // a competitor is named: not final
  return PAST_GATE.has(s.txStatus) ? 'final' : 'wait'
}
```

- `ACCEPTED_BY_NETWORK` is not enough: one node accepted it, and it is one step short of the gate. `RECEIVED` and `SENT_TO_NETWORK` also wait.
- `UNKNOWN` and `PENDING_RETRY` are non-final, never "dead". Read again.
- Never gate on `MINED`, and never add a block wait: BSV nodes follow first-seen with no replacement, so 0-conf at the gate is safe (`threat-model.md`).
- `refused` is a candidate verdict, not yet "dead": apply the two-read rule in "Ordinary failures", and the nuances in "Classify 400s".
- On testnet `SEEN_ON_NETWORK` arrived within 3–10 s of the POST (verified 2026-10-22).

## Classify 400s

A 400 body is `{ error, reason?, txid?, status?, title?, detail?, type? }`, where `status` is the numeric ARC code when the failure is classifiable.

| Answer | Kind | Do |
| --- | --- | --- |
| 400 with `status` 476 (not final: `nLockTime` ahead of median-time-past) | transient | Nothing was persisted, and `GET /tx/{txid}` keeps its prior answer. Re-post the identical transaction after the lock time passes. |
| 400 whose `reason`, `detail` or `error` contains the exact token `TX_EXISTS` or `txn-already-known` | already known | Not a failure. Read `GET /tx/{txid}` and apply the gate. |
| any other 400 (460, 461, 465, 466, ...) | terminal for those bytes | Persisted as `REJECTED`. 460: attach `sourceTransaction` to every input and send EF. 465: re-size the fee from the serialized transaction. 461: fix the transaction. 466: a conflicting spend, terminal unless the competitor is your own earlier copy. |
| 503 (with `Retry-After`), any other status, a network error or a timeout | transient | Nothing was queued. Retry on a bounded schedule; never mark money state from it. |

Match the already-known tokens as whole tokens, not loose prose such as "already". Two reasons are not verdicts even inside a `REJECTED` status:

- `extraInfo` starting `parent rejected` names a rejected ancestor. Re-submit once the ancestor is accepted.
- A reason that blames the inputs (`UTXO_SPENT`, `missingorspent`, "already spent") on a transaction the network had already accepted usually means it was mined or spent by itself. Treat it as no verdict and read again.

## 404 is no verdict

A 404 from `GET /tx/{txid}` means this Arcade instance never saw the txid. It is not a rejection. On testnet, a transaction that had been posted never answered 404, and its status was readable 0.5–2 s after the POST (verified 2026-10-22).

- Submit every transaction you care about to your own Arcade, including ones a user's wallet broadcast through its own services (convert the `createAction` AtomicBEEF to EF). Submission is idempotent.
- A txid reported by a client is a hint, never money evidence: re-broadcast the transaction yourself and gate on your own read.
- Server wallets: `@bsv/wallet-toolbox` 2.14.9 sets no Arcade URL for `main` or `test` by default. Setting `arcadeUrl` only puts Arcade first; in the default `UntilSuccess` mode the toolbox still falls back to GorillaPool and Taal ARC (unless you blank `arcUrl` and `arcGorillaPoolUrl`), then to Bitails and WhatsOnChain, which no option turns off on `main` or `test`. Its own status reads ask WhatsOnChain first (verified 2026-10-22). So also submit its transactions (as EF) to your own Arcade and gate on your own `GET /tx/{txid}`.

## Push instead of polling

- **Webhooks:** send `X-CallbackUrl` (a public HTTPS URL; private and loopback hosts are refused) and `X-CallbackToken` with `POST /tx`. Arcade POSTs `TransactionStatus` bodies to the URL with `Authorization: Bearer <token>`; check the token. Add `X-FullStatusUpdates: true` to get every transition.
- **Server-Sent Events:** `GET /events?callbackToken=<token>` streams status updates for every transaction submitted with that token. Arcade sends `: keepalive` every 15 s; reconnecting with `Last-Event-ID` replays what you missed.
- **Polling** is the fallback: `GET /tx/{txid}` every 1 s with a per-request timeout, for a bounded time, then back off.

## Local Arcade

A self-hosted Arcade's API server listens on port 8080 and its SSE service on port 8082 (verified 2026-10-22). Point the app at it with `ARCADE_URL=http://localhost:8080`. The docs id `guides.services.local-stack` describes a local test chain. Loopback callback URLs are refused, so use SSE or polling locally.

## rawTx caveat

`GET /tx/{txid}` may include `rawTx`, the transaction as Arcade holds it, in Extended Format with placeholder parents. Re-read it as a plain transaction before putting it in a BEEF: `Transaction.fromHexEF(hex).toHex()` (or `.toBinary()`). Do not depend on it being present: the OpenAPI file documents it only while `PENDING_RETRY` (verified 2026-10-22). Building AtomicBEEF from it is in `payments-brc29.md`.

## WhatsOnChain fallback

Arcade has no address or outpoint index. Use WhatsOnChain only for what Arcade cannot answer: address or script listings (`/address/{a}/unspent`), spent-by (`/tx/{txid}/{vout}/spent`), tip height (`/chain/info`) and merkle proofs. Never use it as the truth for a txid you know.

```ts
let next = 0 // one gate per process: every WhatsOnChain call goes through here
export async function woc(path: string, attempt = 0): Promise<Response> {
  const at = Math.max(next, Date.now()); next = at + 350
  await new Promise((r) => setTimeout(r, at - Date.now()))
  const res = await fetch(WOC_BASE + path, { signal: AbortSignal.timeout(10_000) })
  if (res.status !== 429 || attempt >= 4) return res
  next = Math.max(next, Date.now() + 2_000 * 2 ** attempt) // back off on 429
  return woc(path, attempt + 1)
}
```

- Space calls at least 350 ms apart through one gate per process; the free tier allows about 3 requests per second per IP (verified 2026-10-22). An optional `WOC_API_KEY` goes in the `Authorization` header as the raw value.
- A 404 for a fresh transaction means "not indexed yet". WhatsOnChain indexes an unconfirmed spend 6–12 s late (verified 2026-10-22).
- `/address/{a}/unspent` keeps listing coins already spent by an unconfirmed transaction. Check `/tx/{txid}/{vout}/spent` before spending one.
- Check that any hex it returns hashes to the txid you asked for.

## Ordinary failures

These happen and need code; miner collusion is not modelled (`threat-model.md`):

- **Dropped or evicted.** Keep the signed hex and re-post it to Arcade.
- **Two-read dead rule.** A transaction is dead only when Arcade reports `REJECTED`, or names a competing transaction that is not yours, on two reads at least 20 s apart, with a re-post before the second read.
- **Double spend.** `DOUBLE_SPEND_ATTEMPTED` or a non-empty `competingTxs` is a failed payment once the two-read rule above confirms it (a competitor that is not your own copy): then refund or re-plan. Before that, the original can still win under first-seen, and a refund from other coins would pay twice. Often it is the user spending the same coin from another app or device.
- **Unavailable services.** Time out every call and retry on a bounded schedule.
- Never a confirmation wait, and no logic whose only purpose is a miner-collusion threat.

## Check from the shell

`scripts/arcade-check.sh <txid> [arcadeUrl]` prints the `GET /tx/{txid}` JSON and one line `verdict: <seen-no-competitor|on-network-not-seen|pending|terminal|no-verdict>`. The URL defaults to `ARCADE_URL`, else to the public instance for `BSV_NETWORK`. `scripts/arcade-check.sh --policy` prints the fee rate. With the `bsv-mcp` server installed, `arcade_status` gives the same verdict during development.

Docs: resolve `guides.services.broadcasting` with `docs_url`.

# Payment channels: when, which construction, and how to close

Applies to: both
Guardrails: G-08, G-10, G-11, G-13, G-19, G-20, G-22, G-25, G-26, G-28, G-29, G-30, G-33, G-35, G-36, G-37, G-38

A payment channel is one outpoint shared by two parties. They exchange signed states off-chain and broadcast only the open, the close and, in a dispute, one state. The facts (finality rules, what Arcade, Teranode and SV Node do with a non-final transaction, sighash flags, measured sizes) are in `facts.md`, section "Payment channels". This file is the judgment: whether to build one, which shape, and how to open, update and close it safely.

## When a channel is worth it

| question | channel | per-payment BRC-29 | HTTP 402 |
| --- | --- | --- | --- |
| Who pays whom? | the same two parties, many times | anyone to anyone | many clients to one server |
| How many updates per session? | a few dozen or more, seconds apart | fewer than about 20, or minutes apart | one per request |
| Wallet prompts | none after the opening grant | one spend per payment | one payment per request |
| Final when? | at the close; the parties trust their signed states meanwhile | at `SEEN_ON_NETWORK`, within seconds | at `SEEN_ON_NETWORK` |
| Cost to build | high: shared builder, signature exchange, backups, watcher, exits, `Spend` tests, review | low | low with `@bsv/402-pay` |

The reasons:

- **Fees at 100 sat/kB.** A wallet-built payment costs 23–97 sats and one wallet spend. The break-even differs per construction (the facts mark which sizes are measured):
  - B (referee, 1-sat record channel): about 35 sats to open and about 150 sats to close with 80 updates recorded (design estimates: 400 B fixed + 13.5 B per update), about 185 sats in all, the price of 2 to 8 wallet payments.
  - C (covenant, 9.6 KB script): about 3,000 sats to open and close (measured), the price of 31 to 130 wallet payments, plus about 2,945 sats for each state posted on chain in a dispute.
  - A (one-way): not measured; its open and close are small transactions, but size them from the serialized drafts before claiming a break-even.

  The saving that holds for every construction is the wallet prompt and spend each interaction no longer needs.
- **0-conf finality.** A BRC-29 payment is final at `SEEN_ON_NETWORK` with no `competingTxs`, within seconds. A channel buys no finality. It buys free, instant, prompt-less updates and a state both parties signed.
- **Counterparty count.** A channel is one outpoint between two parties (plus, optionally, a referee key). Many payers calling one server: HTTP 402 (BRC-121, `@bsv/402-pay`, see `payments-brc29.md`). One payer making many requests to one server: a one-way channel. Two parties updating shared state: a state channel.
- **Update frequency and session shape.** Fewer than about 20 updates, or updates minutes apart: pay per payment. Per-second or per-step updates inside one session: a channel. A channel has a lifetime (its expiry), needs both parties online to update, a watcher to post at maturity, and backups.
- **Privacy.** Only the open and the close reach the chain, so the amounts and states in between stay between the parties unless one is disputed. The close may still carry a record.
- **Cost of building.** A state builder both sides share, the signature exchange, backups, a watcher, timeout exits, a `Spend` harness and an adversarial review (G-28, G-30). Do not build a channel for fewer than a few dozen updates per session.

## What works today

- Arcade answers a non-final transaction with 476 and persists nothing; it never holds a channel state.
- Teranode rejects a non-final transaction as invalid.
- SV Node's non-final pool is node policy that an app broadcasting through Arcade cannot reach; do not build on it.
- So: private channels only. The parties hold every state, and the newest state carries the earliest lock time (G-35). Nodes keep the first version they see (policy); consensus accepts whichever version is mined.

Of the three ways the Bitcoin SV wiki lists to manage a channel, "in public via mining network" is not available; the two private options are what this file covers.

## Three constructions

| construction | trust | who funds | state carrier | close branches | proven |
| --- | --- | --- | --- | --- | --- |
| A. One-way payment channel | payee trusts its signed updates; payer trusts the refund and the code that asks its wallet to sign (cap the deposit) | payer | a final transaction paying the payee more each time | both (update), both (refund after expiry) | elements only; not run on testnet by BSVA |
| B. State channel with a referee | parties trust the referee to post the newest state; the referee plus either party can spend the channel output, so it carries no value (1 sat) | operator | `nSequence = n`, `nLockTime = base − n × step` | both parties; party one plus referee; party two plus referee | yes, testnet, Oct 2026 |
| C. Trustless covenant channel | none beyond the contract | both parties | `nSequence = state`, `nLockTime = T(k)` on a height schedule | post or pin the newest state, reply, judged close, claim, abandon | yes, testnet, Oct 2026 (seven scenarios) |

**A. One-way payment channel** (payer to payee, metered service). The channel output is a Rúnar contract with one public method, `close(payerSig, payeeSig)`; a bare 2-of-2 also works, but the contract names the branch and gets a `Spend` test. The payer creates the opening without sending it, the payee co-signs a refund to the payer over that txid with `nLockTime = expiry` and `nSequence 0xfffffffe`, and only then does the payer submit the opening (G-20, G-38). Each update is a final transaction (`nSequence 0xffffffff`, `nLockTime 0`) spending the channel to `[payee amount_i, payer change]`, signed by the payer with `0xc1`. The payee keeps the newest and never gains by broadcasting an older one; the payer holds no update it could broadcast. `0xc1` fixes every output, so the closer can add a fee input but not a change output for it (see "Close, cooperative" for who pays the fee). Served-code trust: under the grouped grant the payer's wallet signs `hashToDirectlySign` without a prompt, so a payee that serves the payer's client code can have it sign an update that pays the payee the whole deposit. Cap the deposit like a spending allowance, and keep anything larger behind an explicit prompt (`threat-model.md`). The pre-signed refund and the closer-adds-the-fee pattern were verified on testnet in BSVA's earlier apps, Oct 2026; `0xc1` and the construction as a whole were not run on testnet by BSVA, so run it on testnet before relying on it.

**B. Two-party state channel with a referee.** The operator funds a 1-sat channel output locked to a three-key contract whose methods are the closes. State `n` spends the channel at input 0 with `nSequence = n`, has a 0-sat `OP_FALSE OP_RETURN` record at output 0, and carries `nLockTime = base − n × step`. Both parties sign `0xc3`; at the close the referee adds its fee input and change, signed `0x41`. The referee holds every state and is the real enforcer, because a seconds schedule only orders states nominally. The referee plus either party can spend the channel output with any outputs, so collusion between them can take whatever it holds: keep it at 1 sat and hold any stake elsewhere, in an escrow with its own exits (G-20). Bound the operator's exposure by construction: open only after the first irreversible step of the session, cap the close fee, rate-limit opens per identity, and keep a daily budget (G-19). Verified on testnet in BSVA's earlier apps, Oct 2026.

**C. Trustless covenant channel.** Both parties co-fund (G-22) a Rúnar stateful contract that judges every exit. A state is a `0xc2` signature over `nSequence = state` at `nLockTime = T(k)` on a height schedule. Exits: post or pin the newest state the opponent signed at its maturity, reply on chain, a judged close with exact pinned outputs, a claim after a deadline, an abandon after a horizon. A pre-signed refund of the acceptor's funding coin races an opening the other party withholds. Verified on testnet in BSVA's earlier apps, Oct 2026, in seven scenarios. Building it needs the phase-2 contract references.

## Open

1. Derive each party's channel key under a level-1 protocol (`[1, '<app> channel']`, `keyID` = the session id, `counterparty: 'self'`), so every state signature is silent under the grouped grant (`wallet-brc100.md`). Exchange the public keys.
2. Choose the lifetime: `expiry` (construction A), `lockTimeBase` for a decreasing seconds schedule (B), or an `openHeight` both parties sign for a height schedule (C). Validate it in range before anything is signed (G-36):

```ts
const LOCKTIME_THRESHOLD = 500_000_000 // below: a block height; at or above: Unix seconds
function assertSeconds(lockTime: number): number {
  if (!Number.isInteger(lockTime) || lockTime < LOCKTIME_THRESHOLD || lockTime > 0xffffffff) {
    throw new Error(`lock time ${lockTime} is not Unix seconds`)
  }
  return lockTime
}
const expiry = assertSeconds(Math.floor(Date.now() / 1000) + 24 * 3600)
```

3. Build the opening. One funder: create it signed but unsent (`createAction` with `options.noSend: true`, or `signAndProcess: false` and then `signAction` with `noSend`), so its txid is fixed. Two funders: a foreign input, `signAndProcess: false`, then `signAction` (G-22; the phase-2 multi-party funding reference has the steps).
4. Get every refund signed before the opening is submitted (G-20, G-38). One funder (construction A): the counterparty co-signs the funder's refund over the unsent opening's txid; only then release the opening to the wallet with `createAction({ description, options: { sendWith: [txid] } })` and submit its EF to your own Arcade. In the `@bsv/sdk` 3.2.1 and `@bsv/wallet-toolbox` 2.14.9 sources, a `createAction` with only `sendWith` creates no new transaction and sends the listed `noSend` actions; this release step was not run against wallet-toolbox or BSV Desktop. Co-funded: build and sign the refund of your own funding coin **before** you hand over any signature on the opening.
5. Submit the opening as EF to your own Arcade, and have the counterparty submit it to theirs; submission is idempotent (G-13).
6. Sign no state until Arcade reports the opening `SEEN_ON_NETWORK` or later with no `competingTxs` (G-10).
7. Bind the channel to "the transaction that spends my funding coin", not to a txid seen before every signature was in: the last signer can make a twin.

## Update

- Both sides build state `n` with one pure builder they share, from the same inputs, so the transactions and digests are byte-identical.
- Each signs the BIP-143 double SHA-256 for input 0 with the construction's sighash, through `createSignature({ hashToDirectlySign, protocolID, keyID })`.
- The receiver rebuilds the digest, verifies the signature against the counterparty's channel key (canonical DER, low S, the right sighash byte), and persists it before acting on it (G-38).
- States are cumulative: a signer who fell behind signs only the newest.
- Never sign a digest you received (G-08). Never sign two states at one index over one outpoint (G-37).
- Refuse to sign unless the channel output's value and script equal what you computed (G-37).
- Pick a sighash that binds the channel's value (G-37): `0xc1` for a value split with no covenant; `0xc2` or `0xc3` only when a covenant pins outputs that carry the input's whole value (a Rúnar stateful transition leaves its change output unpinned), the committed output covers every satoshi of the input, or the input carries no value.

Construction B (1-sat record channel), state `n`. For a Rúnar stateful contract, `subscript` is the script after its `OP_CODESEPARATOR`, not the full locking script.

```ts
import { Hash, TransactionSignature as TS } from '@bsv/sdk'

const scope = TS.SIGHASH_SINGLE | TS.SIGHASH_ANYONECANPAY | TS.SIGHASH_FORKID // 0xc3
const preimage = TS.format({
  sourceTXID: ch.txid, sourceOutputIndex: ch.vout, sourceSatoshis: ch.satoshis, subscript: ch.lockingScript,
  transactionVersion: 1, otherInputs: [], outputs: [recordOutput(n)], inputIndex: 0,
  inputSequence: n, lockTime: lockTimeFor(n), scope,
})
const { signature } = await wallet.createSignature({
  hashToDirectlySign: Hash.hash256(preimage), protocolID: channelProtocol, keyID: sessionId, counterparty: 'self',
})
const checksigSig = [...signature, scope] // DER plus the sighash byte, as script expects it
```

`ch` is the channel output you recorded at the open, never one the counterparty sent in this message.

## Close, cooperative

- The close is final: `nSequence 0xffffffff`, `nLockTime 0`, both signatures.
- The fee, per construction:
  - A (`0xc1`): every output is signed, so either the fee is budgeted inside the signed outputs (agree at the open whose output it comes from; by default the payer's change), or the payee adds a coin that goes wholly to the fee, with no change. The payee-signed refund pays its fee the same way: budgeted inside the refund output (the payer bears it), or co-signed `0xc1` so the payer can add a fee coin with no change.
  - B (`0xc3`): the closer adds a fee input (`0x41`) and change at index 1 or later; the state signatures cover only input 0 and output 0, so they stay valid.
  - C: only what the covenant pins; a terminal method pays its fee from the pot or from the inputs it allows.
- Write the hex ahead (write-ahead), submit it as EF to Arcade, and gate on `GET /tx/{txid}` (`arcade-0conf.md`).
- Collect payouts to BRC-29 keys with `internalizeAction` automatically once the close passes the gate (`payments-brc29.md`).
- A close rejected because its fee coin was spent is rebuilt with a fresh fee input; the state signatures stay valid (in A only if the new coin also goes wholly to the fee).

## Close without the counterparty

- The watcher (a client tab, a bot or a server) posts the newest state at its maturity.
- Seconds schedules: make the first attempt at `nLockTime`, and retry every 5 minutes on 476 while median-time-past catches up. Do not wait until `nLockTime + 1 h`: every older state has matured by then too, and nodes keep whichever they see first.
- Height schedules: wait until the tip reaches the lock time, then post. Posted that way, no time-locked covenant transaction was answered 476 (verified on testnet in BSVA's earlier apps, Oct 2026).
- One-way channel: the payee closes at least an hour before `expiry`. When the refund becomes valid depends on median-time-past, which tracks the clock only roughly, and after that the refund can win the race.
- Timeout exits: the pre-signed refund (`nLockTime = expiry`, `nSequence 0xfffffffe`) that the funder keeps; a covenant `claim` or `abandon` after a height horizon.
- Nothing on chain bounds "not after". An opening the other party withholds is beaten by broadcasting the funding refund once the agreed height passes.

## Stale states and disputes

- The newest state matures first; nodes' first-seen policy then makes a stale one a double spend that Arcade reports `REJECTED` 466 with the winner in `competingTxs`. Apply the two-read dead rule (`threat-model.md`) before concluding either way.
- Seconds schedules are nominal: blocks come about every 10 minutes and median-time-past lags, so neighbouring states mature together. The party that holds every state is the enforcer.
- Height schedules with `W` blocks between states let each party defend itself.
- The liveness bound is inherent, because there are no relative lock times: a party must act within `W` blocks of a maturity point.
- Twin openings: a signature over opening A is void if twin B confirms. Follow the confirmed spender of the funding coin.
- A server that only relays messages can delay a channel, not steal from it.
- Every attack found in review becomes a `Spend` test case (G-28).

## Backups

- **What.** The opening AtomicBEEF; the outpoint, value, script and lifetime; every counterparty signature; the newest state both signed, with its unlocking script ready; the pre-signed refund; the list of indices you signed per outpoint.
- **When.** Write-ahead, before you send your signature; after every signature you receive. Keep everything after the close until it is final at the gate, then prune after some days.
- **Where.** Client storage under a per-session key with a single writer per session (two tabs must not overwrite each other), plus the server as a second copy when there is one.
- **Publishing it yourself.** `createAction` with the signed channel input at index 0, `inputBEEF`, and `randomizeOutputs: false`, then submit its EF to your own Arcade (`arcade-0conf.md`). Verified with `@bsv/wallet-toolbox`, not with BSV Desktop; offer the state as a downloadable file as the fallback.

## Rúnar for the covenant

Only for construction C and the close methods of A and B.

- `checkSig` is a plain `OP_CHECKSIG` and verifies whatever sighash the signature carries, so a `0xc2` state signature verifies natively while `extractSequence` reads the state.
- `extractLocktime` plus `< 500000000` on every height gate (G-26).
- Terminal methods pin their outputs with `hash256(outputs) == extractOutputHash` (G-26).
- Version-1 transactions.
- A transition carries the script three times (29 KB for a 9.6 KB script), so run the testnet size gate before UI work (G-29, G-33).
- Upstream Rúnar only (G-25).

## Arcade for the open and the close

- Submit EF hex. A 2xx is provisional; gate on `SEEN_ON_NETWORK` or later with no competitor.
- 476 is transient and persists nothing: resubmit the identical bytes later. A 404 is no verdict.
- Chains of unconfirmed spends are fine.
- Re-post a dropped transaction from its stored hex.
- Submit everything you care about to your own Arcade, including what the counterparty broadcast.

## Review checklist

- Stale state: is the newest state the first to mature, and does the watcher post it then? (G-35)
- Rewritten history: does each signer refuse a second state at an index it already signed over that outpoint? (G-37)
- Signature bound to a foreign output: does the signer check the channel output's value and script before signing? (G-37)
- Unbound value: is every `0xc2` or `0xc3` state over an input that carries no value, whose committed output covers every satoshi, or whose covenant pins outputs that carry the input's whole value? A value split with no covenant is `0xc1`. (G-37)
- Digest from the wire: is every `hashToDirectlySign` digest rebuilt locally? (G-08)
- Milliseconds lock time: is every `nLockTime` Unix seconds or a height, validated in range? (G-36)
- Missing watcher: who posts the newest state at maturity if the counterparty vanishes? (G-38)
- No expiry: is there a pre-signed refund or a covenant timeout, signed before the opening was submitted? (G-38, G-20)
- Served code: is a one-way deposit capped like a spending allowance, with larger stakes behind a prompt? (`threat-model.md`, "Served-code trust")
- No backups: are the opening, every signature and the newest state persisted write-ahead? (G-38)
- Twin opening: is the channel bound to the spender of the funding coin, not to a txid? (G-22)
- 476 treated as dead: is a 476 retried rather than reported as a failure? (G-11, G-35)

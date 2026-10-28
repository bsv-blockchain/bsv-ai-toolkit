---
title: Threat model
verified: 2026-10-22
source: "@bsv/mcp content"
---

# Threat model

What a BSV app defends against, what it deliberately does not, and what it must tell its users.

## 0-conf is safe

BSV nodes follow first-seen: the first valid transaction to spend an output is the one they accept and relay, and a later conflicting transaction is refused. There is no replace-by-fee and no sequence-number replacement. So once Arcade reports a transaction `SEEN_ON_NETWORK` (or later) with no competing transaction, the app treats it as final:

- Payments count, goods ship, state moves and payouts are collected at that point.
- `ACCEPTED_BY_NETWORK` and earlier statuses still wait; they are one step short.
- Nothing waits for `MINED`. Block confirmations are not part of the user experience; on testnet transactions were mined in the next block, about 10 minutes later, with nothing gained by waiting.

A double-spend attempt shows up as `DOUBLE_SPEND_ATTEMPTED` or a non-empty `competingTxs`. Handle it as a failed payment once the two-read dead rule below confirms it (a competitor that is not your own copy); until then the original can still win, and refunding or re-planning early can pay twice.

## Not modelled: miner collusion

A party bribing or colluding with a miner to mine a conflicting transaction is outside this model. Record it as an accepted residual risk in the app's docs and build no machinery for it: no confirmation waits, no switching to a mined twin, no voiding of state already accepted at 0-conf. Machinery whose only purpose is this threat adds complexity and review cost and slows every honest user.

## Ordinary failures to handle

These happen and need code:

- **Dropped or evicted transactions.** A transaction can disappear without being mined. Keep the signed hex and re-post it to Arcade (idempotent).
- **The two-read dead rule.** Treat a transaction as dead only when Arcade reports `REJECTED`, or names a competing transaction that is not yours, on two reads at least 20 s apart, with a re-post before the second read. `UNKNOWN`, `PENDING_RETRY` and a 404 are not verdicts.
- **A 2xx followed by rejection.** Arcade can accept the POST and mark the transaction `REJECTED` milliseconds later. Read the status after every POST.
- **Indexer lag.** WhatsOnChain indexes unconfirmed spends 6–12 s late, can 404 on fresh transactions, and keeps listing coins already spent by unconfirmed transactions. Use it only for what Arcade cannot answer, and read "not found" as "not yet".
- **The user's own conflicting broadcast.** A user can spend the same coin from another app or device. That is a normal double-spend: one side gets `DOUBLE_SPEND_ATTEMPTED`, and the app recovers (refund path, re-plan) rather than treating it as an attack.
- **Unavailable services.** Time out every Arcade and indexer call, retry on 503 and on network errors with a bounded schedule, and never mark money state from a non-terminal answer.

## Channel residuals

A payment channel keeps its states off-chain, so it carries risks a single payment does not:

- **Stale-state race.** Any matured state is valid. Nodes keep the first one they see (policy) and consensus accepts whichever is mined. The newest state must mature first, and its holder must post it at maturity; an older state posted later is then a double spend.
- **Median-time-past lag.** A lock time in seconds matures up to about an hour after its nominal time, and neighbouring states mature in the same block. Prefer height schedules where each party must defend itself.
- **Liveness bound.** There are no relative lock times, so a party must act within the window after a maturity point; one that is offline longer can lose to an older state or a timeout exit.
- **Served-code trust in one-way channels.** Under a grouped grant, `hashToDirectlySign` signs an opaque hash without a prompt (see Served-code trust). A payee that serves the payer's client code can have it sign an update that pays the payee the whole deposit. Cap the deposit like a spending allowance, and keep larger stakes behind an explicit prompt.
- **Twin openings.** The last signer of a co-signed opening can broadcast a twin with another txid. Follow the confirmed spender of the funding coin; signatures over the other twin are void.

Details and the constructions: the `payment-channels` facts and the skill's `payment-channels.md`.

## Served-code trust

Under a BRC-73 grouped grant the wallet signs silently for the app's protocols. Whoever serves the app's JavaScript can therefore request those signatures: a compromised host, build pipeline or dependency can sign anything the grant allows, up to the monthly spending allowance. This is the main residual risk of shape A. Say so in every app's trust model, keep grants narrow (specific level-1 protocols, a small allowance), and keep real stakes behind an explicit prompt.

## Wallet-side residuals

- **Wallet network mismatch.** A local wallet is often on mainnet while the app is on testnet. Read `getNetwork()` and refuse money paths on a mismatch.
- **Signing digests.** `createSignature({ hashToDirectlySign })` signs whatever 32 bytes it is given. Clients sign only digests they rebuilt themselves from data they checked, never a digest received over the wire.
- **Payout checks.** Before signing a transaction that pays the user, the client derives its own expected output (`forSelf: true`) and refuses if the transaction does not pay it the planned amount.
- **Grants do not expire.** Protocol grants persist until the user revokes them, and the spending allowance renews monthly. Request only what the app needs.
- **Wallet extensions.** Permission modules (BRC-98 `p` schemes) bypass the wallet's normal permission manager; a module must authorize its own requests, and an app cannot rely on generic grants for them.
- **Escrow exits.** Any output that needs a counterparty's signature to release needs a no-counterparty exit too (a presigned `nLockTime` refund or a covenant timeout), stored on the client.

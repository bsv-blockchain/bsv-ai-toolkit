---
title: Payment channels
verified: 2026-10-23
source: "@bsv/mcp content"
---

# Payment channels

What a payment channel can and cannot be on BSV today, for an app that broadcasts through Arcade. Measurements marked "testnet, Oct 2026" were verified on testnet in BSVA's earlier apps, Oct 2026.

## What a channel is on BSV

Two parties lock funds in one output, then pass signed transactions that spend it back and forth off-chain, each one updating the balance or the shared state. Only the last version is broadcast. If one party stops answering, the funds come back to the other after a fixed time.

The Bitcoin SV wiki page `https://wiki.bitcoinsv.io/index.php/Payment_Channels` (read 2026-10-23) defines the channel transaction as one with `nSequence < 0xffffffff` and an `nLockTime` in the future, updated between the peers until the lock time arrives or the sequence is made final. It names three ways to manage a channel:

1. "In public via mining network."
2. "In private with pre-funded UTXO per channel."
3. "In private with separate channels for content purchase and service delivery per user."

Only the two private options work for an app built with this kit; the reason is in "Who holds a non-final transaction today" below.

## Sequence numbers, lock times and finality

- A transaction is final at once when every input has `nSequence == 0xffffffff`, or when `nLockTime == 0`.
- Otherwise it is final only when `nLockTime` is strictly less than the comparison value of the block that would mine it: the block height when `nLockTime < 500000000`, the median-time-past (MTP) otherwise. A transaction with `nLockTime = H` can be mined from block `H + 1`.
- MTP lags the wall clock by up to about an hour, so a lock time in seconds matures up to an hour late.
- There are no relative lock times: BIP68 and `OP_CHECKSEQUENCEVERIFY` are NOPs.
- Consensus has no replacement rule. A higher `nSequence` does not replace an earlier version; once the lock time has passed, every signed version that spends the outpoint is equally valid. Nodes keep the first version they see and refuse later conflicting ones (first-seen is node policy); consensus accepts whichever version is mined.

Sources: the `consensus` facts; `util/lock_time.go` in `bsv-blockchain/teranode` (`https://github.com/bsv-blockchain/teranode/blob/main/util/lock_time.go`, read 2026-10-23), whose comment says the strict inequality matches SV Node's `IsFinalTx`.

## Who holds a non-final transaction today

| Service | What it does with a non-final transaction | Source |
| --- | --- | --- |
| Arcade | Answers `POST /tx` with 400 and ARC code 476, and persists no verdict. `GET /tx/{txid}` keeps answering 404 after a submission that only ever got 476. Resubmit the identical transaction once it is final. Arcade never holds, orders or replaces channel states. | `openapi/arcade.openapi.yaml` in `bsv-blockchain/arcade` (`https://github.com/bsv-blockchain/arcade/blob/main/openapi/arcade.openapi.yaml`, read 2026-10-23); the `arcade` facts; an earlier BSVA design that resubmits every 5 minutes on 476 until the state is accepted (a design constant, not a testnet measurement). |
| Teranode | Rejects it as invalid under the consensus rule its source labels TNJ-13. The same comment says payment channels are for the user to set up and run, and that the node "shouldn't be aware or care about them". | `util/lock_time.go` in `bsv-blockchain/teranode`, read 2026-10-23. Read from source, not probed live. |
| SV Node | Keeps a separate non-final (time-locked) transaction pool. This is node policy, not consensus. Default size 50 MiB; an entry not updated for 4 weeks is dropped; a non-final transaction that spends the output of another non-final one is refused; to change a submitted transaction the participants negotiate a new version. | The BSV hub page `https://hub.bsvblockchain.org/wiki/transactions-and-utxos/bitcoin-transactions/transaction-pools`, read 2026-10-23. **Not verified:** whether nodes relay these transactions to each other; that the replacing version must carry a higher `nSequence` (stated on other hub pages, not re-read); the defaults in current SV Node releases. |

An app that broadcasts through Arcade therefore cannot park a channel state on the network. The parties hold every state themselves, and only final transactions are broadcast.

## Sighash flags a channel uses

| Flag | Name | What the signature commits to | Use in a channel | Binds the channel's value? |
| --- | --- | --- | --- | --- |
| `0x41` | ALL\|FORKID | every input and every output | the fee payer's own inputs; a referee's attestation | yes |
| `0xc1` | ALL\|ANYONECANPAY\|FORKID | this input and every output | a balance update between parties with no covenant, with the payer's change output fixed | yes: every output is committed |
| `0xc2` | NONE\|ANYONECANPAY\|FORKID | version, this input's outpoint, scriptCode, value, this input's `nSequence`, and `nLockTime`; no outputs | a signature over a state carried in `nSequence`, which a covenant checks with a plain `OP_CHECKSIG` | no: safe only when a covenant pins outputs that carry the input's whole value, or the input carries no value |
| `0xc3` | SINGLE\|ANYONECANPAY\|FORKID | this input, the output at the same index, and `nLockTime` | a signed record at input 0 and output 0 that lets whoever closes add fee inputs and change at index 1 or later | only that one output: safe when it covers every satoshi of the input, a covenant pins outputs that carry the input's whole value, or the input carries no value (a 1-sat record channel) |

A value split between two parties with no covenant must be signed `0xc1` (or `0x41`). A Rúnar stateful transition does not pin its change output, so the covenant must pin outputs that account for the whole input value before `0xc2` or `0xc3` is safe (see the `runar` facts). With `0xc2` the closer chooses every output; with `0xc3` the closer can add an output that takes whatever the committed output leaves.

The wiki's streaming example asks for a `SIGHASH_ANYONECANPAY | SIGHASH_NONE` signature; on BSV that is `0xc2`, because FORKID is always set.

A signature in script is DER followed by the sighash byte. It must be canonical DER with a low S value. `createSignature({ hashToDirectlySign })` signs the 32 bytes it is given, so pass it the double SHA-256 of the BIP-143 preimage (`TransactionSignature.format` in `@bsv/sdk`, with `scope` set to the flag).

Sources: the BIP-143 digest as implemented by `TransactionSignature.format` in `@bsv/sdk` 3.2.1; testnet, Oct 2026 (`0xc3` and `0xc2` states validated under `@bsv/sdk` `Spend` and mined). `0xc1` is standard BIP-143 and was not used in those apps.

## nSequence as a state carrier

Any `nSequence` below `0xffffffff` keeps `nLockTime` enforced and carries no other meaning, so the field is free space for the channel. An 18-bit game state fitted in it; so did a plain counter of updates. A Rúnar covenant reads it with `extractSequence` and the lock time with `extractLocktime`.

Sources: the `runar` facts; testnet, Oct 2026.

## Ordering states without replacement

With no replacement, the newest state has to become valid first. Two schedules were measured on testnet, Oct 2026:

- **Seconds.** State `n` carries `nLockTime = base − n × 10 s`. Blocks arrive about every 10 minutes and MTP lags, so neighbouring states mature in the same block and the ordering is only nominal. The party that held every state (there, an operator) was the real enforcer.
- **Heights.** State `k` carries `T(k) = openHeight + (9 − k) × W` with `W = 6` blocks. Each state matures a full window before its predecessor, which was enough for each client to defend itself.

A stale state broadcast after the newest one was answered `REJECTED`, ARC 466 `UTXO_SPENT`, with the newer transaction listed in `competingTxs`.

The cooperative close is final (`nSequence 0xffffffff`, `nLockTime 0`) and valid at once.

Source: testnet, Oct 2026.

## Arcade observations for channel transactions

Testnet, Oct 2026:

- A 1-sat channel output and a 0-sat `OP_FALSE OP_RETURN` record output were accepted.
- Chains of unconfirmed covenant spends were accepted and mined together, nine of them in one block.
- Every time-locked covenant transaction (posts, pins, judged closes, claims, the abandon and the refund) was posted once the tip had reached its lock time, read from an indexer first, and none was answered 476.
- `GET /tx/{txid}` answered 0.5–2 s after the POST.
- The opening reached `SEEN_ON_NETWORK` within seconds, and updates started at 0-conf.

Sources: testnet, Oct 2026; the `arcade` facts carry the same timings.

## Sizes and fees

At 100 sat/kB. Sizes are serialized transaction bytes. The covenant and wallet-payment rows were measured on testnet, Oct 2026; the referee rows are design estimates, not measurements.

| Transaction | Size | Fee |
| --- | --- | --- |
| Referee channel: opening with a 1-sat channel output (design estimate) | about 350 B | about 35 sats |
| Referee channel: close carrying a data record (design estimate) | about 400 B fixed + 13.5 B per update, so about 1.5 KB for 80 updates | about 150 sats for 80 updates |
| Covenant channel (9.6 KB script): opening | 10042–10340 B | 1005–1034 sats |
| Covenant channel: a state posted on chain | about 29.4 KB | 2945 sats |
| Covenant channel: close | 19.5–19.6 KB | about 1970 sats |
| Covenant channel: pre-signed refund | 191 B | 20 sats |
| Per-payment alternative: a wallet-built P2PKH payment | 225–965 B | 23–97 sats, one wallet spend each |

In the referee channel the operator pays the opening and the close; the two parties pay nothing. Anchoring the same 80 updates as separate transactions was computed at about 4,300 sats and observed at about 8,000 sats with wallet rounding and change, and cost each party a wallet prompt per update (40 each).

Sources: the `fees` facts carry the same covenant and wallet-payment measurements; the referee estimates and the anchoring figures are from BSVA's earlier apps, Oct 2026 (the anchoring cost observed on testnet).

## What cannot be done on chain

- No transaction can be bounded "not after" a time or height. Lateness is handled by racing the late transaction with a conflicting spend, such as a pre-signed refund.
- Script cannot read the current height. Deadlines are anchored to an opening height that both parties signed, and every height gate also asserts `nLockTime < 500000000`, or a timestamp passes it.
- The last signer of a multi-party transaction can produce a twin with the same inputs and outputs and a different txid. Bind the channel to "the transaction that spends coin X", not to a txid seen before every signature was in (see the `consensus` facts).

Sources: the `consensus` facts; testnet, Oct 2026.

## Wallet facts for channels

- `createSignature({ hashToDirectlySign })` signs exactly the 32 bytes given (the double SHA-256). Under a level-1 protocol covered by a BRC-73 grouped grant it signs without a prompt, one call per state (see the `wallet-limits` facts).
- `@bsv/wallet-toolbox` keeps provided inputs first and, with `randomizeOutputs: false`, keeps outputs in the given order. A state signed by both parties can therefore be published through such a wallet with `createAction`, the signed channel input at index 0; then submit its EF to your own Arcade (see the `arcade` facts). **Not verified:** whether BSV Desktop keeps that order. The fallback is to hand the user the signed state as a file.

Sources: the `wallet-limits` facts; testnet, Oct 2026 (verified with `wallet-toolbox`; publishing through BSV Desktop was not run).

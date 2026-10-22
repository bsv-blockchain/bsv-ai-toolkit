---
title: Consensus and policy facts
verified: 2026-10-22
source: "@bsv/mcp content"
---

# Consensus and policy

BSV restored the original protocol at the Genesis upgrade. Several Bitcoin habits do not apply.

## Sequence numbers and lock times

- Post-Genesis, `nSequence` is only a finality flag: an input with `nSequence < 0xffffffff` makes `nLockTime` count. There is no transaction replacement, and a higher sequence number does not replace an earlier version on the network.
- BIP68 and `OP_CHECKSEQUENCEVERIFY` are NOPs. There are no relative lock times. `OP_CHECKLOCKTIMEVERIFY` is a NOP too; lock-time logic in script reads `nLockTime` from the transaction preimage.
- `nLockTime < 500000000` is a block height; otherwise it is a Unix time compared with median-time-past (MTP). MTP lags the wall clock by up to about an hour, so a time-locked transaction becomes valid up to an hour after its nominal time.
- A script that gates on a height must also assert `nLockTime < 500000000`, or a timestamp passes the check.
- Arcade answers a not-yet-final transaction with ARC code 476 and keeps no record of it. Resubmit the identical transaction once it is final.

## Opcodes and digests

- There is no `OP_CHECKDATASIG` (that is Bitcoin Cash). A signature over arbitrary data in script needs a Rabin signature (`verifyRabinSig`), or a covenant that reads the spending transaction. Script-level ECDSA costs about 1 MB of script, over the default script-size policy.
- Chronicle activated on mainnet at height 943816 (2026-04-07). It adds opcodes and a sighash flag, and relaxes malleability rules for transactions with version greater than 1. Stay on version-1 transactions and BIP-143 sighash digests unless you specifically need Chronicle features.

## Default node policy

| Policy | Default |
| --- | --- |
| `maxscriptsizepolicy` | 500000 bytes |
| `maxtxsizepolicy` | 10 MB |
| Script numbers | up to 750000 bytes |

Arcade's `/policy` reports what it enforces, which can be larger (see the `arcade` facts). Individual nodes may still apply these defaults.

## Txid malleability

A txid covers the unlocking scripts. When several parties sign one transaction, the last signer can produce a second valid transaction with the same inputs and outputs and a different txid (a twin). Another party's `SIGHASH_ALL` signature fixes inputs and outputs, not the other scriptSigs. Bind protocol state to "the transaction that spends coin X", not to a txid you saw before every signature was in.

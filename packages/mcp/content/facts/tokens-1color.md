---
title: 1Color tokens (BRC-162, BRC-207)
verified: 2026-10-22
source: "@bsv/mcp content"
---

# 1Color tokens

1Color is the fungible token standard for BSV apps: BRC-162 defines the output format, BRC-207 the wallet module that holds and spends it. 1Color is the binary encoding of the BSV-21 token model; BRC-161 is the JSON-inscription encoding of the same model, and a token's id is shared across both.

## BRC-162 output layout

Every token output's locking script starts with a prefix that is pushed and then dropped, so any script can follow it:

```
<token id | OP_0> <amount | OP_0> OP_2DROP [<payload> OP_DROP] <rest of the locking script>
```

- **Token id**: the outpoint of the token's deploy output. On the wire it is the deploy txid as 32 bytes in internal byte order (deploys under BRC-162 are always output 0). A 36-byte form (txid plus little-endian vout) exists only for tokens first deployed under BRC-161 at a non-zero output. For display and APIs the id is `<txid>_<vout>`, for example `<64 hex>_0`.
- **Amount**: a minimally encoded script number, 1 to 2^64 − 1 for value. Zero (`OP_0`) marks authority, not an empty balance.
- **Payload** (optional): one push followed by `OP_DROP`. Fields are read only when it is a strictly valid DAG-CBOR map. Deploy-only display fields are `sym` (symbol, not unique), `icon` (`[mediaType, bytes]`) and `dec` (decimals 0–18, display only). Reserved keys `req` and `ext` declare wallet processing profiles; `req` is fixed at deploy.
- **Rest**: any valid locking script (P2PKH, multisig, a covenant). There is no protocol tag: the layout is the marker.

## Roles and operations

| Token id | Amount | Role |
| --- | --- | --- |
| empty | > 0 | Deploy, fixed supply: the whole supply in this output |
| empty | 0 | Deploy, authority supply: the first minting authority |
| present | 0 | Authority: may mint, split, combine, transfer or end |
| present | > 0 | Value: a spendable balance |

- **Deploy** is valid only at output 0. That output's outpoint becomes the token id.
- **Transfer**: value outputs are admitted only when the sum of the token's value inputs covers them. If outputs exceed inputs, the outputs are invalid and the inputs are burned. If inputs exceed outputs, the difference is burned.
- **Mint**: spending a valid authority lets the transaction create value outputs without covering inputs.
- **Burn**: give up value by not recreating it (explicit or implicit).
- **Authority** outputs can be split, combined, re-locked to a new owner, or ended. Minting stops only when no authority output remains.

Validity is enforced by indexers and overlays, not by miners. Always key tokens by deploy outpoint, never by symbol.

**1 sat convention:** token outputs usually hold 1 satoshi. That is ecosystem practice, not a protocol rule; BRC-207 services admit valid outputs whatever their satoshi value.

## BRC-207 wallet flow

The `color` wallet module works through the existing BRC-100 calls:

- **Keys**: each managed output's key is derived like BRC-29, with protocol `[2, "p color <assetTag> <prefixTag> <suffixTag>"]` and `keyID` `color`. `assetTag` is the deploy txid hex, `v`, and the output index (or `issue` for a new deploy); prefix and suffix tags are the hex of the remittance strings' UTF-8 bytes.
- **Baskets**: one value basket `p color <assetTag>` and one authority basket `p color <assetTag> authority` per asset. Read-only `listOutputs` views `p color assets`, `p color balance <assetTag>` and `p color balance <assetTag> authority` give inventory and exact balances.
- **Plans**: an action's intent (assets, owned outputs, operations such as `transfer`, `mint`, `burn`, `deploy-fixed`, `authority-split`, input and change positions) travels as JSON, hex encoded in `labels` of the form `p color plan <partIndex> <partCount> <hexChunk>`, at most 200 hex characters per chunk. Burns and authority operations must be declared explicitly.
- **Signatures**: `createSignature` with the module protocol, `keyID: "color"` and `data` set to a UTF-8 JSON envelope `{version: 1, tx, inputIndex, sighashType, ownedOutputs}` where `tx` is Atomic BEEF bytes; `hashToDirectlySign` must be absent. The wallet computes the digest itself and returns a DER signature.
- **Overlay admission**: per asset, topic `tm_color_<assetId>` and lookup service `ls_color_<assetId>`. Before releasing any spend signature, the wallet checks every token input against the asset's overlay for current spendability, using providers the user has accepted.
- **Receiving**: `internalizeAction` with `basket insertion` into the asset's basket and `customInstructions` `{version: 1, assetId, derivationPrefix, derivationSuffix, senderIdentityKey}`.
- **Discovery**: a wallet with the module may advertise `brc207-color=4` in its version string (BRC-205). Absence does not prove the module is missing.

## Implementation status (2026-10-22)

| Piece | Status |
| --- | --- |
| BRC-162 encoding | `@bsv/templates` 2.0.0 ships `Bsv21Binary`, a script template for the binary prefix. |
| Overlay | `@bsv/overlay-topics` 2.0 (2.0.1 on npm) ships `Bsv21TopicManager` and `Bsv21LookupService` plus a BRC-162 ledger module. The per-asset `tm_color_<assetId>` naming is BRC-207's; check which topic names a host actually serves. |
| BRC-207 wallet module | Only in interim forks under `@bopen-io/*` (for example `@bopen-io/wallet-toolbox` 2.15.1). Not in `@bsv/wallet-toolbox` 2.14.9, and BSV Desktop does not support it yet. |
| BRC-162 "Implementations" section | "None yet". |

## Naming history

Earlier drafts of the binary format were called Mandala Tokens and then Colored Tokens. The original Mandala Token Protocol (BRC-92) is withdrawn. Token ids, scripts and amounts did not change with the rename, and the wallet module does not accept earlier `p mandala` identifiers.

## Scope in this kit

Phase 1 gives encoding guidance only: how to build and read BRC-162 outputs with `Bsv21Binary`, and how ids, roles and balance rules work. Wallet-held 1Color balances wait for BRC-207 to land in `@bsv/wallet-toolbox` and BSV Desktop. `@bsv/simple`'s `createToken` makes PushDrop tokens, which are not 1Color.

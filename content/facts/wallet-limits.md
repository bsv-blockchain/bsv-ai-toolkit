---
title: BRC-100 wallet limits and permissions
verified: 2026-10-22
source: "@bsv/mcp content"
---

# BRC-100 wallet limits

## Client-side result limits

`@bsv/sdk` checks these on the client for every wallet substrate (`WalletClient`, HTTP JSON, `window.CWI`, Wallet Wire). A wallet that answers outside them fails in the app, whatever the wallet itself allows.

| Call | Limit |
| --- | --- |
| `getPublicKey` result | `publicKey` is 33 bytes (66 hex), a valid compressed point |
| `createSignature` result | canonical DER, at most 72 bytes |
| `verifySignature` argument | DER at most 72 bytes, checked before sending |
| `createHmac` result | exactly 32 bytes |
| `encrypt` / `decrypt` results | any byte array up to 256 MiB; the only calls that carry arbitrary bytes |
| `protocolID` | `[0..2, string of 5–400 chars]` in the SDK (the BRC-43 text says 280) |
| `keyID` | 1–800 characters in the SDK (BRC-43 allows up to 1033 bytes) |
| `createSignature` arguments | exactly one of `data` or `hashToDirectlySign`. `hashToDirectlySign` is 32 bytes and must be the **double**-SHA256 digest of what you mean to sign. Sign only digests you rebuilt yourself, never one received over the wire. |

Extending a wallet beyond these limits goes through a BRC-98 `p <scheme>` permission module, not a new method. Such modules bypass the wallet's normal permission manager, so a module must authorize its own requests and must reject `p`-namespace baskets and labels.

## BRC-29 payment derivation

- Protocol ID `[2, '3241645161d8']`.
- `keyID = prefix + ' ' + suffix` (derivation prefix and suffix, base64 strings, joined by one space).
- The sender derives the recipient's key with `counterparty = recipient` (the recipient's identity key).
- The recipient verifies the same key with `counterparty = sender` and `forSelf: true` before signing anything that pays it.
- The recipient collects with `internalizeAction({ protocol: 'wallet payment', paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix } })`.
- Keep derivations deterministic or persisted. A random prefix and suffix that were never saved make the payment unrecoverable.

## Grouped permissions manifest (BRC-73)

The wallet reads `https://{originator}/manifest.json`. Serve the same object under both keys:

- `metanet.groupPermissions` (the current key)
- `babbage.groupPermissions` (the key BSV Desktop reads)

Contents:

- `spendingAuthorization { amount, description }`: `amount` is a **monthly** allowance in sats per originator. There is no duration field. Keep it small.
- `protocolPermissions [{ protocolID, counterparty?, description }]`
- `basketAccess [{ basket, description }]`

Serve it as `application/manifest+json` with open CORS and no caching, ahead of any single-page-app rewrite. Protocol grants do not expire.

## Permission levels

| Level | Scope | Prompt behaviour (BSV Desktop) |
| --- | --- | --- |
| 0 | none | never prompts |
| 1 | per originator and protocol | one grouped grant covers every `keyID` and counterparty; use it for anything signed repeatedly |
| 2 | per originator, protocol and counterparty | a manifest entry needs a `counterparty`; without one the wallet prompts once per new peer. Whether `counterparty: 'self'` counts as grouped is unsettled. |

To raise the grouped prompt at "Connect wallet" rather than at the first real action, make one harmless protected call right after reading the identity key, for example `getPublicKey({ protocolID: <your level-1 id>, keyID: 'permissions', counterparty: 'self' })`. Discard the result and never await it in the login path.

## Login

`new WalletClient('auto', originator)` → `waitForAuthentication()` → `getPublicKey({ identityKey: true })` (the user's id) → `getNetwork()`, refusing to continue on a mismatch. In `@bsv/sdk` 3.2.1, `isAuthenticated()` throws on a locked wallet; never use it as a gate.

## Transport limits

- BSV Desktop accepts request bodies up to 50 MB (`express.json({limit:'50mb'})`) and does no extra SDK validation on its server side.
- `@bsv/auth-express-middleware` (BRC-103/104) caps parsed JSON bodies at roughly 100 k nodes, so BEEF sent as a `number[]` is limited to about 100 kB. Send larger BEEFs as `beefHex` strings.

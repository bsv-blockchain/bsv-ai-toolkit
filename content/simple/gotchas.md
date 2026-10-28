---
title: "@bsv/simple 0.7 gotchas"
verified: 2026-10-22
source: "@bsv/mcp content"
---

# @bsv/simple 0.7 gotchas

Read from the `@bsv/simple` 0.7.0 package source on 2026-10-22. Each item says what to do instead.

## `network` defaults to `main`

`createWallet`, `ServerWallet.create` and `ServerWalletManager` all default `network` to `'main'`: real money. Always pass `network: 'testnet'` while building, and take the value from one `BSV_NETWORK` setting.

- The spelling is `'testnet' | 'main'`, unlike the SDK wallet's `'testnet' | 'mainnet'` and wallet-toolbox's `'test' | 'main'`.
- In the browser, `network` is only a label. `createWallet` does not ask the wallet which network it is on, and a local wallet is often on mainnet. Call `wallet.getClient().getNetwork({})` yourself and refuse money paths on a mismatch.
- `Overlay.create` defaults its `network` to `'mainnet'`; pass `'testnet'`.
- Mapping from the kit's `BSV_NETWORK` (`testnet` | `mainnet`): `@bsv/simple` wallets take `'testnet'` | `'main'` (map `mainnet` to `'main'`); `Overlay.create` takes `'testnet'` | `'mainnet'` unchanged.

## No `arcadeUrl` option

There is no way to point `@bsv/simple` at Arcade.

- In the browser the user's wallet broadcasts.
- `ServerWallet.create` builds wallet-toolbox `Services` with their defaults, which in `@bsv/wallet-toolbox` 2.14.9 broadcast through legacy ARC endpoints for `main` and `test`.

When you need tracking (the `SEEN_ON_NETWORK` gate, `competingTxs`, rejection reasons), drop to `@bsv/sdk` + Arcade for that step: take the transaction the action returns, submit it to your own Arcade (`POST /tx`, as EF), and read `GET /tx/{txid}`. For a server wallet that broadcasts through Arcade first, build the wallet-toolbox wallet yourself with `arcadeUrl` in its services options. That alone is not enough: the toolbox still falls back to GorillaPool and Taal ARC (unless `arcUrl` and `arcGorillaPoolUrl` are blank), and then to Bitails and WhatsOnChain. No option disables those last two on `main` or `test`, and the toolbox's status reads ask WhatsOnChain first. For money decisions, keep submitting to your own Arcade and gating on its `GET /tx/{txid}`.

## `pay()` via MessageBox may return an empty txid

`pay({ to, satoshis })` sends through MessageBox peer-to-peer payment and can return `txid: ''`. In 0.7.0 it also ignores `memo` and `description`. `sendMessageBoxPayment` returns `'sent'` or `''` in its `txid` field, never a real txid.

Never treat either result as proof of payment. For a payment the app must verify, use `createPaymentRequest` + `sendDirectPayment`, submit the transaction to Arcade, and wait for the 0-conf gate.

## `basket insertion` and `wallet payment` are mutually exclusive per output

`internalizeAction` takes one protocol per output:

- `wallet payment` (with `paymentRemittance`) adds the output to the wallet's spendable balance.
- `basket insertion` (with `insertionRemittance`) files it in a named basket for the app to manage.

You cannot do both for one output. `acceptIncomingPayment(payment)` without a `basket` uses `wallet payment`, so the sats become spendable. With a `basket` it uses `basket insertion`, and the output stays in that basket. Omit `basket` for ordinary payments.

`fundServerWallet(request, basket?)` passes `basket` into the payer's own `createAction` output. Leave it unset unless you mean the payer's wallet to file that output.

## Server `authorize` callback

`createServerWalletHandler` denies every route (HTTP 403) until its `authorize` callback returns literal `true`. Bind the callback to your authenticated session and check the specific action (`status`, `create`, `request`, `balance`, `outputs`, `receive`, `reset`). Never deploy `authorize: () => true` on a public route. `createCredentialIssuerHandler` follows the same rule for `certify`, `issue` and `revoke`.

## Server key and storage

- `ServerWalletManager` reads the key from `SERVER_PRIVATE_KEY`. If that is unset it generates a key and writes it, in plain JSON, to `.server-wallet.json` in the working directory. Add that file to `.gitignore` and set the variable in every deployed environment.
- `ServerWallet.create` stores wallet records on the remote storage service `https://storage.babbage.systems` unless you pass `storageUrl`. Decide where your custody records live before going to mainnet.

## Other traps

- `createWallet` connects with `new WalletClient('auto', 'simple')`, a fixed originator. Not confirmed: whether a given wallet then keys permissions and the BRC-73 manifest lookup to `simple` or to the page's origin. If your app relies on a grouped-permission manifest, connect with your own `WalletClient('auto', yourOrigin)` from `@bsv/sdk` for that part.
- `createToken` makes encrypted PushDrop tokens, not 1Color tokens.
- The bundled identity registry is unauthenticated: a tag lookup is a hint, not proof of who controls a key.
- Multi-party funding, foreign inputs, contracts and AtomicBEEF assembly are outside `@bsv/simple`; use `@bsv/sdk` and the wallet's `createAction` / `signAction` through `getClient()`.

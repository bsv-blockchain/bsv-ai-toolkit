# Decide whether @bsv/simple fits

Applies to: both
Guardrails: G-02, G-06, G-09, G-13, G-21, G-23

`@bsv/simple` 0.7.0 wraps `@bsv/sdk` (and, on the server, `@bsv/wallet-toolbox`) in a small task-level API. Use it for payments, data, messaging or certificates in a Next.js or Express app, where shape B is acceptable with the limits below. Everything else goes to `@bsv/sdk` directly. The full method list is the `bsv://simple/api` resource and the traps are `bsv://simple/gotchas`, both read from the 0.7.0 package (verified 2026-10-22).

## What @bsv/simple 0.7 covers

- **Wallets.** `createWallet(defaults?)` in the browser, backed by the user's BRC-100 wallet (shape A). `ServerWallet.create({ privateKey, network?, storageUrl? })` from `@bsv/simple/server`, backed by a wallet-toolbox wallet (shape B). Both expose the identity key, balance, key derivation and `getClient()`, the underlying `WalletInterface`.
- **Payments.** `send` (several outputs in one transaction), BRC-29 direct payments (`createPaymentRequest`, `sendDirectPayment`, `receiveDirectPayment`), `fundServerWallet`, and MessageBox `pay`.
- **Data.** `inscribeText`, `inscribeJSON`, `inscribeFileHash`, `inscribeImageHash`: OP_RETURN outputs up to 1 MiB.
- **Tokens.** Encrypted PushDrop tokens (`createToken`, `sendToken`, `redeemToken`). These are not 1Color tokens.
- **Messaging, certificates, DID, overlay.** MessageBox delivery, certifiers and proposed BRC-203 credentials, `did:key` identifiers, SHIP/SLAP overlay clients.
- **Server routes.** `createServerWalletHandler(config)` returns Next.js-style `{ GET, POST }` handlers behind an `authorize` callback.

## What it does not

- **Arcade.** There is no `arcadeUrl` option, so the library gives you no `SEEN_ON_NETWORK` gate, no `competingTxs` and no rejection reasons.
- **A network check.** In the browser `network` is only a label: `createWallet` does not ask the wallet which network it is on.
- **HTTP 402.** No helper. Use `@bsv/402-pay` (BRC-121) next to a shape B server wallet.
- **1Color tokens, Rúnar contracts, multi-party funding with foreign inputs, AtomicBEEF assembly.**
- **Your own originator.** `createWallet` connects as `WalletClient('auto', 'simple')`. Not confirmed: whether a wallet then keys permissions and the BRC-73 manifest to `simple` or to the page's origin.

## Traps

- **`network` defaults to `'main'`: real money.** `createWallet`, `ServerWallet.create` and `ServerWalletManager` all default to mainnet. Always pass it, mapped from the kit's one `BSV_NETWORK` setting (`testnet` or `mainnet`):
  - `@bsv/simple` wallets take `'testnet' | 'main'`: map `mainnet` to `'main'`.
  - `Overlay.create` takes `'testnet' | 'mainnet'` unchanged, and defaults to `'mainnet'`.
  - For comparison, `getNetwork()` on a BRC-100 wallet returns `'testnet' | 'mainnet'`, and wallet-toolbox's `Chain` is `'test' | 'main'`.
- **Check the wallet's real network.** Call `wallet.getClient().getNetwork({})` before every money path and refuse on a mismatch (G-02). A local BSV Desktop is often on mainnet.
- **No `arcadeUrl`.** In the browser the user's wallet broadcasts. `ServerWallet.create` builds wallet-toolbox `Services` with their defaults, which in 2.14.9 broadcast through legacy ARC endpoints, not Arcade, for `main` and `test`.
- **`pay()` may return an empty txid.** It pays through MessageBox and can return `txid: ''`; in 0.7.0 it also ignores `memo` and `description`. `sendMessageBoxPayment` puts `'sent'` or `''` in its `txid` field. Never treat either as proof of payment.
- **Server `authorize` callback.** `createServerWalletHandler` answers 403 on every route until `authorize` returns literal `true`. Bind it to your authenticated session and check the specific action (`status`, `create`, `request`, `balance`, `outputs`, `receive`, `reset`). Never deploy `authorize: () => true` on a public route. `createCredentialIssuerHandler` follows the same rule.
- **Server key and storage.** `ServerWalletManager` reads `SERVER_PRIVATE_KEY`; when it is unset it generates a key and writes it in plain JSON to `.server-wallet.json` in the working directory. Add that file to `.gitignore` and have the operator set the variable in every deployed environment. `ServerWallet.create` keeps wallet records on `https://storage.babbage.systems` unless you pass `storageUrl`.
- **One protocol per output.** `acceptIncomingPayment(payment)` without a `basket` uses `wallet payment` (spendable); with one it uses `basket insertion`. Omit `basket` for ordinary payments.

```ts
const network = BSV_NETWORK === 'mainnet' ? 'main' : 'testnet' // @bsv/simple spelling
const wallet = await createWallet({ network })
const { network: actual } = await wallet.getClient().getNetwork({})
if (actual !== BSV_NETWORK) throw new Error(`Wallet is on ${actual}; switch it to ${BSV_NETWORK}`)
```

## When to drop to @bsv/sdk

- **Any money decision.** Take the transaction the action returns, submit it as EF to your own Arcade (`POST /tx`) and gate on your own `GET /tx/{txid}`: `SEEN_ON_NETWORK` or later with no competing transaction (`arcade-0conf.md`).
- **A payment the app must verify.** Use `createPaymentRequest` + `sendDirectPayment`, not `pay()`, and count it only at the gate (G-23).
- **A grouped-permission manifest under your own origin.** Connect with your own `WalletClient('auto', yourOrigin)` from `@bsv/sdk` for that part (`wallet-brc100.md`).
- **1Color tokens, contracts, foreign inputs, multi-party funding, AtomicBEEF.** Use `@bsv/sdk` and the wallet's `createAction` / `signAction` through `getClient()` (`payments-brc29.md`).

## Shape B recommendation

Until ts-stack gives `@bsv/simple`'s server wallet a testnet default and an `arcadeUrl` option, build a shape B server wallet without it:

- **`@bsv/wallet-toolbox`** with SQLite storage (what `Setup.createWalletSQLite` sets up) and `Services` built with `arcadeUrl` set. In 2.14.9 `Setup.createWalletSQLite` builds default `Services` and takes no services option (verified 2026-10-22), so assemble the wallet the way `Setup.createWallet` does, with your own services:

  ```ts
  const options = Services.createDefaultOptions(chain) // chain: 'test' | 'main', from BSV_NETWORK
  options.arcadeUrl = ARCADE_URL || PUBLIC_ARCADE[BSV_NETWORK] // never '': an empty string drops Arcade
  const services = new Services(options) // then new Wallet({ chain, keyDeriver, storage, services, monitor })
  ```

  `PUBLIC_ARCADE` maps `testnet` and `mainnet` to the public Arcade hosts in `arcade-0conf.md`.

- **or go-wallet-toolbox** with Arcade configured as its broadcaster.

Setting `arcadeUrl` only puts Arcade first in the broadcaster list; it does not make Arcade the only one. In the default `UntilSuccess` mode the toolbox still falls back to GorillaPool and Taal ARC (unless you blank `arcUrl` and `arcGorillaPoolUrl`), and then to Bitails and WhatsOnChain, which no option turns off on `main` or `test`. Its own status reads ask WhatsOnChain first and Arcade second. So the app also submits every money transaction (as EF) to its own Arcade and gates on its own `GET /tx/{txid}`, whatever the wallet did. The other shape B rules (root key outside the repo, write-ahead records, bounded budgets, a "fund the server" path) are in `custody-shapes.md`.

## Prompts in @bsv/mcp

With the `bsv-mcp` server installed, three prompts build on the same facts, testnet first:

- `integrate_simple` (`framework`: `next`, `express`, `react` or `node`): add `@bsv/simple` 0.7 to a project.
- `add_simple_feature` (`feature`: `payments`, `tokens`, `inscriptions`, `messagebox`, `certificates`, `did` or `overlay`).
- `debug_simple` (`symptom`): checks the network, each gotcha, then `arcade_status` for a known txid.

Docs: `get_doc` or `search_docs` on the BSV docs MCP for the `@bsv/simple` pages.

# Connect a BRC-100 wallet

Applies to: shape A (the signing and result-limit rules also hold for a shape B server wallet)
Guardrails: G-01, G-02, G-03, G-04, G-05, G-06, G-07, G-08

The user's BRC-100 wallet (BSV Desktop or any other) holds the keys. The app talks to it through `@bsv/sdk` 3.x `WalletClient`, never sees a private key, and uses the wallet's identity key as the user's id: no passwords, no accounts. Exact limits and manifest fields are in `facts.md` (section "BRC-100 wallet limits and permissions").

## Login sequence

Run these in order, once, when the user clicks "Connect wallet":

```ts
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto', originator) // originator: the domain that serves manifest.json
await wallet.connectToSubstrate()                   // finds the wallet; fails fast if none is running
await wallet.waitForAuthentication()                // resolves once the user has unlocked the wallet
const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
const { network } = await wallet.getNetwork()       // 'testnet' | 'mainnet'
if (network !== BSV_NETWORK) throw new Error(`Wallet is on ${network}; switch it to ${BSV_NETWORK}`)
```

- **`waitForAuthentication()` is the gate, never `isAuthenticated()`.** In `@bsv/sdk` 3.2.1, `isAuthenticated()` throws `Invalid isAuthenticated result` on a locked wallet instead of returning `false` (verified 2026-10-22).
- **`identityKey` is the user's id.** Store it as the account key; it is a 33-byte compressed public key in hex.
- **Refuse on a network mismatch.** A local BSV Desktop is often on mainnet while the app runs on testnet. `BSV_NETWORK` is one setting read by both server and client (when the bundler needs a public prefix, derive the prefixed copy from `BSV_NETWORK` at build time, never set it separately; `testnet-to-mainnet.md`). Show the wallet's network in the UI, and read `getNetwork()` again before every money path: the user can switch networks without logging out.
- **No wallet found:** `connectToSubstrate()` rejects with `No wallet available over any communication substrate`. Tell the user to install and open a BRC-100 wallet; BSV Desktop serves on local ports 3321 (HTTP) and 2121 (HTTPS) (verified 2026-10-22).

## Manifest (BRC-73)

The wallet reads `https://{originator}/manifest.json` to show one grouped permission prompt. Ship `public/manifest.json`, starting from `assets/manifest.template.json`:

- Put the same object under **both** `metanet.groupPermissions` (the current key) and `babbage.groupPermissions` (the key BSV Desktop reads, verified 2026-10-22). Identical contents.
- Fields: `spendingAuthorization { amount, description }` (a **monthly** allowance in sats per originator; there is no duration field), `protocolPermissions [{ protocolID, counterparty?, description }]`, `basketAccess [{ basket, description }]`.
- Serve it as `application/manifest+json`, with open CORS and no caching, from a route registered **before** any single-page-app rewrite (otherwise the rewrite answers with `index.html`):

```ts
app.get('/manifest.json', (_req, res) => {
  res.set({
    'Content-Type': 'application/manifest+json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  })
  res.send(manifest)
}) // register before the SPA fallback route
```

On a static host, set the same three headers for `/manifest.json` in its headers config and exclude the path from the rewrite.

## Protocol levels

| Level | Granted per | Use it for |
| --- | --- | --- |
| 1 | originator and protocol | anything signed repeatedly: one grouped grant covers every `keyID` and counterparty |
| 2 | originator, protocol and counterparty | per-peer keys; the manifest entry needs a `counterparty`, and without one the wallet prompts once per new peer |

- Design repeated signing around a level-1 protocol, for example `[1, 'myapp actions']` with `keyID` set per record or session.
- Protocol names: the SDK trims and lowercases the name, then rejects it unless it is 5 to 400 characters of letters, digits and single spaces, not ending in ` protocol` (`@bsv/sdk` 3.2.1, verified 2026-10-22). Use lowercase letters, digits and single spaces only, for example `[1, 'my app actions']`: `my-app actions` passes the manifest checks and then throws at the first signature. Basket names are trimmed and lowercased, so declare them in lowercase.
- BRC-29 payments use the level-2 protocol `[2, '3241645161d8']`; the template's entry carries `counterparty: 'self'`. Whether BSV Desktop treats `'self'` as grouped is unsettled (verified 2026-10-22).
- Keep `spendingAuthorization.amount` small: it covers small payments silently, and anything larger should prompt. Grants do not expire, and the allowance renews monthly; request only what the app needs.

## Raise the one prompt early

Right after reading the identity key, fire one harmless protected call so the grouped prompt appears at "Connect wallet" rather than at the user's first real action. Discard the result and never await it in the login path:

```ts
void wallet
  .getPublicKey({ protocolID: [1, 'myapp actions'], keyID: 'permissions', counterparty: 'self' })
  .catch(() => {}) // a refusal here surfaces again at the first real action
```

## Signing

- `createSignature({ protocolID, keyID, counterparty?, hashToDirectlySign })` signs exactly the 32 bytes it is given. Pass the **double**-SHA256 digest of what you mean to sign (for a transaction input, the BIP-143 sighash preimage hashed twice). Pass exactly one of `data` or `hashToDirectlySign`.
- **Sign only digests you rebuilt.** Rebuild the digest from data you checked yourself; never sign a digest received over the wire. A digest from someone else lets them get your signature over anything.
- Before signing a transaction that pays the user, check its outputs first (see `payments-brc29.md`, "Verify before signing anything that pays you").
- The app never holds a private key in client code, and never derives a secret from `createHmac` or symmetric keys: a counterparty can compute those too.

## Result limits

`@bsv/sdk` validates wallet results on the client for every substrate, so a wallet that answers outside these fails in the app (verified 2026-10-22):

| Call | Limit |
| --- | --- |
| `getPublicKey` | `publicKey` is 33 bytes (66 hex), a valid compressed point |
| `createSignature` | canonical DER, at most 72 bytes |
| `verifySignature` argument | DER at most 72 bytes |
| `createHmac` | exactly 32 bytes |
| `encrypt` / `decrypt` | any bytes up to 256 MiB: the only calls that carry arbitrary bytes |
| `protocolID` | `[level, name]`: level 0, 1 or 2; name of 5–400 characters |
| `keyID` | 1–800 characters |

## Extending a wallet

Need a result outside these limits (another signature scheme, a non-secp256k1 key)? Do not add a method. Wallet extensions go through a BRC-98 `p <scheme>` permission module:

- `p`-prefixed requests bypass the wallet's normal permission manager and grouped grants, so the module must authorise its own requests (levels, grant scope, caps, fail closed without a prompt).
- The module must reject `p`-namespace baskets and labels; passing them through bypasses basket and label permission checks.
- Apps cannot rely on a manifest grant for a `p` protocol.

## Docs

Resolve these ids with the `docs_url` tool (or `facts.md`, section "Docs links"):

- `guides.wallet-aware-apps`: permissions, manifest and baskets.
- `reference.wallet-api`: every BRC-100 method and its arguments.
- `get-started.quick-start-browser`: a first payment from a web app.
- `guides.identity-auth`: authenticating users with their wallet.

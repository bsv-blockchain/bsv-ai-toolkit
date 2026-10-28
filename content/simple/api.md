---
title: "@bsv/simple 0.7 API"
verified: 2026-10-22
source: "@bsv/mcp content"
---

# @bsv/simple 0.7 API

`@bsv/simple` 0.7.0 wraps `@bsv/sdk` (and, on the server, `@bsv/wallet-toolbox`) in a small task-level API. Read the gotchas page before using it: it defaults to mainnet. Method names below are read from the 0.7.0 type declarations; every method that touches the wallet returns a Promise.

Install: `npm install @bsv/simple @bsv/sdk` (Node >= 22).

## Wallet (browser/server)

Two entry points share one API surface:

| Import | Wallet | Backed by |
| --- | --- | --- |
| `@bsv/simple` (also `@bsv/simple/browser`) | `createWallet(defaults?)` → `BrowserWallet` | the user's BRC-100 wallet through `WalletClient` |
| `@bsv/simple/server` | `ServerWallet.create({ privateKey, network?, storageUrl? })` → `ServerWallet` | a `@bsv/wallet-toolbox` wallet from a private key |

```ts
import { createWallet } from '@bsv/simple'
const wallet = await createWallet({ network: 'testnet' })

import { ServerWallet } from '@bsv/simple/server'
const server = await ServerWallet.create({ privateKey: process.env.SERVER_PRIVATE_KEY!, network: 'testnet' })
```

`defaults` (`WalletDefaults`): `network` (`'main' | 'testnet'`), `description`, `outputDescription`, `tokenBasket`, `tokenProtocolID`, `tokenKeyID`, `messageBoxHost`, `registryUrl`, `registryFetch`.

Common methods on both wallets:

| Method | Returns |
| --- | --- |
| `getIdentityKey()`, `getAddress()` | identity public key hex; its P2PKH address |
| `getStatus()`, `getWalletInfo()` | connection state, identity key, configured network |
| `getBalance(basket?)` | `{ totalSatoshis, totalOutputs, spendableSatoshis, spendableOutputs }` |
| `derivePublicKey(protocolID, keyID, counterparty?, forSelf?)` | derived public key hex |
| `derivePaymentKey(counterparty, invoiceNumber?)` | derived payment public key hex |
| `getClient()` | the underlying `WalletInterface`, for anything the wrapper does not cover |

Server-only helpers in `@bsv/simple/server`: `generatePrivateKey()`, `ServerWalletManager` and `createServerWalletHandler(config)` (Next.js-style `{ GET, POST }` routes for status, create, request, balance, outputs, receive and reset; requires an `authorize` callback), `JsonFileStore`, `FileRevocationStore`, `createCredentialIssuerHandler`, `IdentityRegistry` / `createIdentityRegistryHandler`, and `toNextHandlers`, `jsonResponse`, `getSearchParams`.

## Payments and 402

| Method | What it does |
| --- | --- |
| `pay({ to, satoshis, memo?, description? })` | Pays an identity key through MessageBox peer-to-peer payment. Returns `{ txid, tx }`; `txid` may be empty. |
| `send({ outputs, description? })` | One transaction with several outputs. Each output spec takes `to` + `satoshis` (P2PKH), `data` (OP_RETURN), or `data` + `basket`/`protocolID`/`keyID` (PushDrop). Returns `outputDetails` with each output's `type`. |
| `createPaymentRequest({ satoshis, memo? })` | Synchronous. A `PaymentRequest` `{ serverIdentityKey, derivationPrefix, derivationSuffix, satoshis, memo? }` for a payer to fulfil. |
| `sendDirectPayment(request)` | Pays a `PaymentRequest` to a BRC-29 derived key. Returns the transaction plus the remittance (`senderIdentityKey`, `derivationPrefix`, `derivationSuffix`, `outputIndex`). |
| `receiveDirectPayment(payment)` | Recipient side: internalizes that output with `wallet payment` into the spendable balance. |
| `fundServerWallet(request, basket?)` | Pays a server wallet's `PaymentRequest` (BRC-29 output, optional OP_RETURN memo, `acceptDelayedBroadcast: false`). |
| `ServerWallet.receivePayment(payment)` | Deprecated alias of `receiveDirectPayment`. |

The usual server-funding flow: the server calls `createPaymentRequest`, the browser calls `fundServerWallet(request)`, the server calls `receiveDirectPayment` with the returned remittance and transaction.

HTTP 402: `@bsv/simple` 0.7.0 has no 402 helper. For pay-per-request APIs use `@bsv/402-pay` (BRC-121; 0.3.3 on npm on 2026-10-22) next to a shape B server wallet.

## Tokens

These are PushDrop tokens with an encrypted payload, not 1Color tokens (see the `tokens-1color` facts).

| Method | What it does |
| --- | --- |
| `createToken({ data, to?, basket?, protocolID?, keyID?, satoshis? })` | Encrypts `data` and locks it in a PushDrop output. Returns `{ txid, tx, basket, encrypted }`. |
| `listTokenDetails(basket?)` | Decrypted `{ outpoint, satoshis, data, protocolID, keyID, counterparty }` per token. |
| `sendToken({ basket, outpoint, to })` | Transfers a token to an identity key. |
| `redeemToken({ basket, outpoint })` | Spends a token back to plain satoshis. |
| `sendTokenViaMessageBox({ basket, outpoint, to })` | Transfers and delivers through MessageBox. |
| `listIncomingTokens()`, `acceptIncomingToken(token, basket?)` | Recipient side for MessageBox deliveries. |

## Inscriptions/data

Each writes an OP_RETURN data output through `send`, in a default basket unless you pass one. Data is capped at 1 MiB.

| Method | Default basket |
| --- | --- |
| `inscribeText(text, { basket?, description? })` | `text` |
| `inscribeJSON(object, opts?)` | `json` |
| `inscribeFileHash(sha256Hex, opts?)` | `hash-document` |
| `inscribeImageHash(sha256Hex, opts?)` | `hash-image` |

All return `{ txid, tx, type, dataSize, basket, outputs }`. For arbitrary data alongside payments, use `send` with `data` outputs.

## MessageBox

Peer-to-peer delivery through a MessageBox host (`defaults.messageBoxHost`).

| Method | What it does |
| --- | --- |
| `sendMessageBoxPayment(to, satoshis)` | Sends a payment token to an identity key's `payment_inbox`. Returns `{ txid, amount, recipient }`, where `txid` is a marker, not a txid. |
| `listIncomingPayments()` | Pending payments in your inbox. |
| `acceptIncomingPayment(payment, basket?)` | Internalizes one payment (by `messageId`): `wallet payment` with no basket, `basket insertion` with one. |
| `certifyForMessageBox(handle, registryUrl?, host?)`, `getMessageBoxHandle(registryUrl?)`, `revokeMessageBoxCertification(registryUrl?)` | Handle certification for the legacy identity directory. |
| `registerIdentityTag(tag, registryUrl?)`, `lookupIdentityByTag(query, registryUrl?)`, `listMyTags(registryUrl?)`, `revokeIdentityTag(tag, registryUrl?)` | The legacy, unauthenticated identity directory. Treat results as hints and confirm keys independently. |

## Certificates/DID

| API | What it does |
| --- | --- |
| `Certifier.create({ privateKey?, certificateType?, defaultFields?, includeTimestamp? })`, `certifier.certify(wallet, fields?)`, `certifier.getInfo()` | A standalone certifier that issues BSV certificates. |
| `acquireCertificateFrom({ serverUrl, schemaId?, fields?, replaceExisting? })` | Requests a certificate from a remote HTTPS certifier and stores it. |
| `listCertificatesFrom({ certifiers, types, limit? })`, `relinquishCert({ type, serialNumber, certifier })` | List or drop held certificates. |
| `CredentialSchema`, `CredentialIssuer.create({ privateKey, schemas?, revocation? })`, `issuer.issue(...)`, `issuer.verify(...)`, `issuer.revoke(serialNumber)`, `MemoryRevocationStore` | Proposed BRC-203 verifiable-credential envelopes over BRC-52 certificates. |
| `acquireCredential(config)`, `listCredentials({ certifiers, types, limit? })` | Holder side for credentials. |
| `getDID()`, `resolveDID(did)`, `DID.fromIdentityKey(key)`, `DID.resolve(did)` | Proposed BRC-202 `did:key` identifiers from identity keys. Resolution is offline and proves only the key encoding, not control of the key. |

## Overlay

| API | What it does |
| --- | --- |
| `Overlay.create({ topics, network?, slapTrackers?, hostOverrides?, additionalHosts?, ... })` | A client for SHIP/SLAP overlay services. |
| `overlay.broadcast(tx, topics?)`, `overlay.query(service, query, timeout?)`, `overlay.lookupOutputs(service, query)` | Submit to topics; query lookup services. |
| `overlay.addTopic(t)`, `removeTopic(t)`, `getInfo()`, `getBroadcaster()`, `getResolver()` | Configuration and the underlying SDK objects. |
| `advertiseSHIP(domain, topic, basket?)`, `advertiseSLAP(domain, service, basket?)` | Publish host advertisements (topics must start `tm_`). |
| `broadcastAction(overlay, { outputs, description? }, topics?)` | Create an action and submit it to the overlay in one call. |
| `withRetry(operation, overlay, maxRetries?)` | Retry wrapper for overlay operations. |

Not confirmed from the type declarations alone: the exact retry policy of `withRetry`, and how `broadcastAction` handles a partial acknowledgement. Read the source before relying on either.

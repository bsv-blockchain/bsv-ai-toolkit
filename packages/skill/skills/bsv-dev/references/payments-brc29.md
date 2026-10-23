# Send and receive BRC-29 payments

Applies to: both (the payer and the recipient may each be a user's wallet or a server wallet)
Guardrails: G-02, G-12, G-13, G-16, G-17, G-21, G-23, G-24

A BRC-29 payment goes to a key derived for one recipient from one sender, and the recipient collects it with `internalizeAction` plus the remittance that re-derives the key. Use it for every payment and payout between wallets: a `@bsv/wallet-toolbox` wallet cannot spend plain P2PKH coins it did not create or internalize, and a BRC-29 output internalized with its remittance is spendable by any BRC-100 wallet. Check `getNetwork()` (or the server wallet's chain) before every step below.

## Derive the payee key

- Protocol ID `[2, '3241645161d8']`; `keyID = prefix + ' ' + suffix`.
- The **sender** derives the recipient's key with `counterparty = recipient` (the recipient's identity key).
- `prefix` and `suffix` are 16 random bytes each, base64-encoded.
- **Persist them before broadcasting**, with the sender's identity key, the amount and the output index. With `acceptDelayedBroadcast: false` the wallet broadcasts inside `createAction`, so save them before that call. A random prefix and suffix that were never saved make the payment unrecoverable.
- Test and bot wallets derive prefix and suffix deterministically, so a funding script can retry by txid instead of paying again.

```ts
import { P2PKH, PublicKey, Random, Utils } from '@bsv/sdk'

const prefix = Utils.toBase64(Random(16))
const suffix = Utils.toBase64(Random(16))
await saveRemittance({ // write-ahead, before createAction
  prefix, suffix, recipient, satoshis, outputIndex: 0, senderIdentityKey: identityKey,
})
const { publicKey } = await wallet.getPublicKey({
  protocolID: [2, '3241645161d8'], keyID: `${prefix} ${suffix}`, counterparty: recipient,
})
const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
```

## Pay

```ts
const { txid, tx } = await wallet.createAction({
  description: 'Payment for order 42',
  outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 payment' }],
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
})
await arcade.submit(Transaction.fromAtomicBEEF(tx!).toHexEF()) // track it in your own Arcade
```

- `randomizeOutputs: false` keeps your output at the index you planned, so the remittance's `outputIndex` stays right.
- `acceptDelayedBroadcast: false` makes the wallet broadcast now and return errors in the result instead of retrying later in the background.
- The result's `tx` is AtomicBEEF (BRC-95): the transaction plus its whole ancestry. Hand it to the recipient as is, with `{ senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex }`.
- The wallet broadcast through its own services, so your Arcade has never seen the transaction. Submit it as EF (`arcade-0conf.md`, "Submit") and gate on your own `GET /tx/{txid}`.
- Payout outputs carry at least 546 sats, the dust threshold for outputs a wallet will track.

## Collect

The recipient (a user's wallet, or the server's wallet in shape B) collects in this order:

1. Verify the output pays its own derived key ("Verify before signing anything that pays you", below).
2. Submit the transaction to its own Arcade and wait for the gate: `SEEN_ON_NETWORK` or later with no competing transaction (`arcade-0conf.md`). A txid or BEEF reported by a client is a hint, never money evidence.
3. Internalize:

```ts
await wallet.internalizeAction({
  tx: atomicBeef, // complete AtomicBEEF of the paying transaction
  outputs: [{
    outputIndex,
    protocol: 'wallet payment',
    paymentRemittance: { senderIdentityKey, derivationPrefix: prefix, derivationSuffix: suffix },
  }],
  description: 'Payment received', // required, 5–50 bytes
})
```

- `protocol` is either `'wallet payment'` (with `paymentRemittance`, into the wallet's balance) or `'basket insertion'` (with `insertionRemittance`, into a named basket) for each output. One output is never both.
- **Collect automatically** as soon as the gate passes, at 0-conf, not on page load or behind a button: a recipient who stays on the page must still get paid. On failure retry after 10 s, then 30 s, then every 60 s, up to a bound you choose; keep the remittance so a later visit resumes. Record success so you do not internalize twice.

## Complete AtomicBEEF

`internalizeAction` needs a complete AtomicBEEF: every unproven ancestor, down to mined ones with merkle proofs. An incomplete one fails with `WERR_INVALID_PARAMETER` and a message about a complete, exactly framed Atomic BEEF. A `createAction` result is already complete. When you build the paying transaction yourself (a server payout, a contract close), assemble its BEEF from what you hold:

```ts
const beef = new Beef()
for (const held of heldBeefs) beef.mergeBeef(held) // createAction results, a counterparty's funding BEEF
for (const parent of parentsNotHeld) {
  const s = await arcade.status(parent)             // GET /tx/{txid} on your Arcade
  const bump = s.merklePath ? beef.mergeBump(MerklePath.fromHex(s.merklePath)) : undefined
  beef.mergeRawTx(Transaction.fromHexEF(s.rawTx!).toBinary(), bump) // EF re-read as plain
}
beef.mergeRawTx(payoutTx.toBinary())
const atomicBeef = beef.toBinaryAtomic(payoutTx.id('hex'))
```

- Arcade's `rawTx` is Extended Format with placeholder parents. `Transaction.fromHexEF(hex)` then `.toBinary()` (or `.toHex()`) gives the plain transaction. In `@bsv/sdk` 3.2.1 `beef.mergeRawTx` takes bytes, not hex (verified 2026-10-22).
- Never call `beef.mergeTransaction` on a transaction parsed from EF: it merges the placeholder parents too and the BEEF is invalid.
- `rawTx` is not guaranteed to be present (verified 2026-10-22); when it is missing, the parent must come from a BEEF you already hold. Keep every BEEF a wallet or counterparty gives you.
- Never rebuild ancestry one ancestor at a time from an indexer: it is slow, hits 429 rate limits and can be incomplete.
- Check `beef.isValid()` before handing the bytes to a wallet.

## Verify before signing anything that pays you

Before signing or co-signing a transaction that pays you (a settlement, a refund, a close), and before internalizing, derive the key you expect and compare:

```ts
const { publicKey } = await wallet.getPublicKey({
  protocolID: [2, '3241645161d8'], keyID: `${prefix} ${suffix}`,
  counterparty: senderIdentityKey, forSelf: true,
})
const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
const out = tx.outputs[outputIndex]
if (out.lockingScript.toHex() !== expected || out.satoshis !== plannedSatoshis) {
  throw new Error('This transaction does not pay you the planned amount')
}
```

Refuse to sign when it does not match.

## HTTP 402

To sell per-request API access, use BRC-121 through `@bsv/402-pay` 0.3.x (0.3.3 on npm, verified 2026-10-22). The server receives with a shape B server wallet; the paying client may be a user's wallet or another server. `@bsv/simple` 0.7.0 has no 402 helper. Resolve the docs id `guides.payments` with `docs_url` for the walkthrough; `reference.wallet-api` documents `createAction` and `internalizeAction`.

One client paying one server many times in a session may be better served by a one-way payment channel; the trade-off and the construction are in `payment-channels.md`.

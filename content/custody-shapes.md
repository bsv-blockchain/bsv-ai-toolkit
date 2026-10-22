---
title: Custody shapes
verified: 2026-10-22
source: "@bsv/mcp content"
---

# Custody shapes

Every BSV app decides who holds the keys that move money. There are two shapes. Pick one per money path, explicitly, before writing code; the guardrails are tagged A, B or both.

## Shape A: user-side BRC-100 wallet

The user's own wallet (BSV Desktop or any BRC-100 wallet) holds the keys. The app talks to it through `WalletClient('auto', originator)` and never sees a private key.

What you get:

- **Identity without accounts.** `getPublicKey({ identityKey: true })` is the user's id. No passwords, no sign-up.
- **Per-app keys.** Keys are derived per protocol and counterparty (BRC-42/43), so each app sees its own keys, not the user's root.
- **Silent signing under BRC-73.** With a grouped-permission manifest and level-1 protocols, the user approves once at "Connect wallet", then repeated signing needs no prompt. A small monthly spending allowance covers small payments.
- **Settlement without the server.** Users fund and sign their own transactions. The server can relay, check and index, but it holds no money and nothing stalls when it is down.

What it costs:

- Users must install a BRC-100 wallet.
- Level-2 protocols (per counterparty) prompt once per new peer; design around level 1 where you can.
- **Served-code trust.** Whoever serves the app's JavaScript can request signatures under the grouped grant. State this in the app's trust model (see `threat-model`).

## Shape B: app-side server wallet

The app runs its own wallet on a server: `@bsv/wallet-toolbox` (for example `Setup.createWalletSQLite`), `go-wallet-toolbox`, or `@bsv/simple`'s `ServerWallet` (which wraps wallet-toolbox).

What you get:

- **Automation.** Payouts, bots and agents act with no user present.
- **HTTP 402 receipts.** A server can sell per-request access and take payment over HTTP (BRC-121; `@bsv/402-pay`).
- **No user wallet needed** for the parts of the app the server handles.

What it costs:

- **Operator custody.** The operator holds keys and funds and carries the security and legal weight of that.
- **Key and storage operations.** The root key lives outside the repo; the wallet's storage needs backups and migrations.
- **Fee budgets.** Every operator-paid transaction draws on a balance that someone must top up.
- **Bookkeeping.** Write-ahead records, idempotency and retries are the operator's job.

## Decision questions

Answer each yes or no:

| Question | Yes | No |
| --- | --- | --- |
| 1. Can every money movement be signed by the person whose money it is, while they are using the app? | Shape A covers it | Shape B for the movements that cannot |
| 2. Must the app move money when no user is present (scheduled payouts, bots, agents)? | Shape B for that path | Shape A |
| 3. Does the operator need to pay fees or hold funds between steps? | Shape B, with the rules below | Shape A |
| 4. Are the paying clients machines or agents calling an HTTP API (402)? | Shape B receives; the client may be either shape | Shape A |
| 5. Will your users install a BRC-100 wallet? | Shape A is open to you | Shape B, or wait until they have one |

When both shapes would work, prefer A: it keeps the operator out of custody.

## Rules inside shape B

- **Bounded budgets.** Cap operator-paid fees by construction: a per-action cap, a per-identity rate and a daily budget.
- **Write-ahead records.** Persist signed transaction hex and payment remittances before broadcasting. On restart, re-broadcast from what you persisted. Key every money route by txid so a retry returns the stored answer.
- **Never count client-reported txids.** A txid from a client is a hint. Re-broadcast the transaction through your own Arcade and count it only at `SEEN_ON_NETWORK` or later with no competing transaction.
- **Deterministic derivations.** Bot and test wallets derive keys deterministically, and every BRC-29 prefix and suffix is saved before it is used, so a funding script can retry by txid instead of paying again.
- **A "fund the server" path.** Print the funding address at startup and in a status endpoint, and give a way to pay it from a user's wallet (`createAction` to that address after checking `getNetwork()`). An empty server wallet produces its own clear message, never a silent failure.
- **Funding a wallet-toolbox wallet.** A wallet-toolbox wallet cannot spend P2PKH coins it did not create or internalize. Fund it with a BRC-29 payment collected by `internalizeAction`, or sweep coins from a root-key P2PKH address into it with `Setup.fundWalletFromP2PKHOutpoints`.
- **Broadcast through Arcade.** `@bsv/wallet-toolbox` 2.14.9's default services for `main` and `test` broadcast through legacy ARC endpoints; pass an Arcade URL in the services options (`arcadeUrl`) so every status read and broadcast goes through Arcade. `@bsv/simple`'s `ServerWallet` has no such option (see the `@bsv/simple` gotchas).
- **Coins, if you track them yourself.** Mark a coin spent when you select it, record change only once its txid is final, forget a refused transaction and everything built on it, and never let a delayed release free a coin that was claimed again.

## Both shapes may coexist

One app can use both, one per money path. A common split: users pay from their own wallets (A) to a BRC-29 key derived for the server, the server collects with `internalizeAction` and pays out automatically (B). Keep the boundary explicit: the server never signs for user funds, and the user's wallet never trusts a server-reported status that it can read from Arcade itself.

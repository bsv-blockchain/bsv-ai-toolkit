# bsv-tipping-demo

A tipping app built the way the BSV AI devkit recommends: custody shape A (each user's wallet holds the keys), testnet first, Arcade for broadcast and status, and `check_guardrails` reporting zero errors.

One Node process serves the web app, `/manifest.json`, `/api` and `/health` on one origin, which is the wallet originator. The relay holds no key.

## What it demonstrates

- **Connect and network check.** The page connects a BRC-100 wallet (such as BSV Desktop), waits until it is unlocked, and refuses to tip or collect when the wallet's network differs from the app's `BSV_NETWORK`.
- **One grouped permission.** `public/manifest.json` grants one level-1 protocol, BRC-29 for the user's own payments, one basket, and a small monthly allowance. Login raises the prompt once.
- **A BRC-29 tip.** The tipper's wallet pays a key derived for the creator. The derivation is saved in the browser before the wallet broadcasts. The relay takes the transaction to its own Arcade and reads the status.
- **Collection at 0-conf.** The creator page (`/creator`) hears about each tip over server-sent events. Once Arcade reports the transaction `SEEN_ON_NETWORK` or later with no competing transaction, the page collects it with `internalizeAction`, with automatic retries at 10, 30 and 60 s. The tip list shows each tip's status as it changes.

## Run locally

You need Node 22.9 or later, pnpm, and BSV Desktop (or another BRC-100 wallet) switched to **testnet**, with some testnet coins in it.

```bash
cp env.example .env   # optional; the defaults are testnet and http://localhost:5173
pnpm install          # from the repo root
pnpm dev              # in this folder: web on http://localhost:5173, relay on :8080
```

`pnpm dev` and `pnpm start` read `.env` in this folder when it exists. A variable already set in the shell wins over `.env`.

A tip needs two identities: the creator and a tipper. Use two browser profiles, each connected to a different wallet, or two wallets.

1. As the creator, open `http://localhost:5173/creator` and connect. With `CREATOR_IDENTITY_KEY` unset, the first wallet to claim this page becomes the creator. Set `CREATOR_IDENTITY_KEY` in `.env` to fix the creator instead.
2. As the tipper, open `http://localhost:5173/`, connect, choose an amount (at least 546 sats), and send. Your wallet may ask you to approve the payment.
3. The creator page shows the tip once Arcade has seen it, and the tip lands in the creator's wallet.

`pnpm build && pnpm start` runs the built app on `PORT` (default 8080), after `scripts/network-guard.sh` has checked `BSV_NETWORK`. Set `PUBLIC_ORIGIN=http://localhost:8080` when you open it there. `pnpm test` runs the tests. None of them reaches a wallet or the network.

## Trust model

The relay cannot spend, redirect or forge a tip. Tippers sign in their own wallets, and the creator collects in theirs. Whoever serves this JavaScript can ask the wallet to sign under the app's grouped permission, so the manifest keeps the allowance small. A tip is final for the app at `SEEN_ON_NETWORK` or later with no competing transaction. See [TRUST.md](TRUST.md) for the full statement and the residual risks.

## Guardrails

[GUARDRAILS.md](GUARDRAILS.md) maps each guardrail that applies to this app to the file that meets it.

```bash
pnpm -F @bsv/mcp build   # from the repo root, once
pnpm guardrails          # in this folder; expects 0 errors
```

## Testnet gate

`pnpm gate` runs one real tip end to end on testnet, with headless wallets, through the same modules the page uses. It is the check that this app works against the real network. The gate's root key lives outside the repo, in `~/.bsv-gate/tipping-shape-a.key` (or `$BSV_GATE_KEY_FILE`), or in `BSV_TESTNET_GATE_KEY` on CI. Nothing prints it.

```bash
pnpm gate init                              # create the key if absent; print the funding address
pnpm gate address                           # print the funding address and identity keys only
BSV_MCP_NETWORK_TESTS=1 pnpm gate run       # one tip: tipper -> relay -> Arcade -> creator, coins back to the address
pnpm gate sweep --txid <faucet txid>        # optional: prove a faucet payment is spendable
pnpm gate recover --dir <run dir>           # finish a run that kept its dir
```

Fund the printed address from a testnet faucet before `run`. The gate refuses `BSV_NETWORK=mainnet`.

## Docs

The pages this app builds on:

- <!-- docs_url: get-started.quick-start-browser --> [Send a payment from a web app](https://bsv.writedocs.io/docs/get-started/quick-start-browser)
- <!-- docs_url: guides.payments --> [Gate an API behind payments](https://bsv.writedocs.io/docs/guides/payments)
- <!-- docs_url: guides.wallet-aware-apps --> [Request permissions and organize outputs](https://bsv.writedocs.io/docs/guides/wallet-aware-apps)
- <!-- docs_url: guides.services.broadcasting --> [Broadcast transactions with Arcade](https://bsv.writedocs.io/docs/guides/services/broadcasting)

## Hosting

The image is `ghcr.io/bsv-blockchain/bsv-tipping-demo`, and `docker-compose.yml` runs it. [HOSTING.md](HOSTING.md) covers the environment, the volume, the reverse proxy and the network switch.

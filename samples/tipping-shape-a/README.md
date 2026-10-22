# bsv-tipping-demo

A tipping app built the way the BSV AI devkit recommends: custody shape A (each user's wallet holds the keys), testnet first, Arcade for broadcast and status, and `check_guardrails` reporting zero errors.

One Node process serves the web app, `/manifest.json`, `/api` and `/health` on one origin, which is the wallet originator. The relay holds no key.

This README is a stub; setup, hosting and gate instructions follow.

## Run locally

```bash
cp env.example .env   # optional; defaults are testnet
pnpm install
pnpm dev              # web on http://localhost:5173, relay on :8080
```

`pnpm build && pnpm start` runs the built app on `PORT` (default 8080) after `scripts/network-guard.sh` checks `BSV_NETWORK`.

## Trust model

The relay cannot spend, redirect or forge a tip: tippers sign in their own wallets and the creator collects in theirs. Whoever serves this JavaScript can ask the wallet to sign under the app's grouped permission, so the manifest keeps the allowance small. The full statement lands in `TRUST.md`.

## Guardrails

```bash
pnpm -F @bsv/mcp build   # from the repo root, once
pnpm guardrails          # expects 0 errors
```

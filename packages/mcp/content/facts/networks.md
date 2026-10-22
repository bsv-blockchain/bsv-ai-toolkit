---
title: Networks and endpoints
verified: 2026-10-22
source: "@bsv/mcp content"
---

# Networks

Build and test on testnet. Mainnet is real money: switch to it only by explicit configuration (one `BSV_NETWORK` variable read by both server and client), and refuse money paths when the user's wallet reports a different network.

| | testnet | mainnet |
| --- | --- | --- |
| Arcade default | `https://arcade-testnet-us-1.bsvblockchain.tech` (live and used for testnet work, though not listed on the public Arcade docs page) | `https://arcade-us-1.bsvblockchain.tech` |
| Arcade alternates | `https://arcade-v2-testnet-us-1.bsvblockchain.tech` | `https://arcade-eu-1.bsvblockchain.tech`, `https://arcade-ap-1.bsvblockchain.tech`, `https://arcade-v2-us-1.bsvblockchain.tech`; also `https://arcade.gorillapool.io` (listed in the Arcade docs, not in `versions.json`) |
| WhatsOnChain API base | `https://api.whatsonchain.com/v1/bsv/test` | `https://api.whatsonchain.com/v1/bsv/main` |
| Explorer | `https://test.whatsonchain.com` | `https://whatsonchain.com` |
| Getting coins | Faucet `https://bsvfaucet.com`: sign in with a BSV wallet, up to 10M sats per request, 24 h cooldown | Buy BSV; there is no faucet |
| Fee reality | Arcade minimum 1 sat/kB | 100 sat/kB on every datahub Arcade reports |
| `getNetwork()` (`@bsv/sdk` BRC-100 wallet) returns | `'testnet'` | `'mainnet'` |
| `@bsv/wallet-toolbox` `Chain` | `'test'` | `'main'` |

The `Chain` type in `@bsv/wallet-toolbox` 2.14.9 also has `'stn'`, `'ttn'`, `'tstn'` and `'mock'`; apps use only `'test'` and `'main'`. `@bsv/simple` 0.7.0 has a third spelling, `'testnet' | 'main'` (see the `@bsv/simple` gotchas).

The hosts above are the ones in `content/versions.json` (`services.arcade.hosts`), all live at `v0.16.0` on 2026-10-22. The `arcade-v2-*` hosts are the ones hardcoded in `@bsv/wallet-toolbox`'s network configuration.

## Local wallet

BSV Desktop, the reference BRC-100 desktop wallet, serves the wallet interface locally on HTTP port **3321** and HTTPS port **2121**; `WalletClient('auto', originator)` finds it. A local BSV Desktop is often set to mainnet: read `getNetwork()` before any money path.

## ttn

`https://arcade-v2-ttn-us-1.bsvblockchain.tech` serves a Teranode test network. It is neither testnet nor mainnet: coins, blocks and txids there do not exist on either. Use it only when you mean to, as an explicit Arcade URL; tools in this kit accept it only that way and warn.

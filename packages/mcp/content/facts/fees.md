---
title: Fee rates and measured costs
verified: 2026-10-22
source: "@bsv/mcp content"
---

# Fees

## Rates

| Network | Minimum Arcade accepts | Rate to configure |
| --- | --- | --- |
| testnet | 1 sat/kB | 100 sat/kB, so testnet sizes and costs carry over to mainnet |
| mainnet | 100 sat/kB on every datahub Arcade reports | 100 sat/kB |

100 sat/kB is also the default rate of BSV Desktop and `@bsv/wallet-toolbox`. Read `GET /policy` on your Arcade before relying on any number here; rates are set by the network and can change.

## Measured sizes and costs

Measured on testnet, Oct 2026, paying 100 sat/kB. Sizes are serialized transaction bytes.

| Transaction | Size | Fee |
| --- | --- | --- |
| P2PKH funding transaction from a BRC-100 wallet | 225–965 B | 23–97 sats |
| Opening that creates a 9.6 KB covenant output (two funding inputs) | 10042–10340 B | 1005–1034 sats |
| Stateful covenant transition (spends the covenant and recreates it with new state) | 29436–29439 B | 2944–2945 sats |
| Covenant close paying out to two parties | 19509–19620 B | about 1970 sats |
| Small P2PKH refund or withdrawal | 191–328 B | 20–33 sats |

A stateful covenant transition carries the covenant script three times (see the `runar` facts), which is why it is roughly three times the script size.

## Rules

- Size every fee from the serialized draft transaction at the configured rate, never from a guess. An estimate that assumed a few hundred bytes for a transaction carrying a 9.6 KB output made every real submission fail.
- Wallet payout outputs carry at least 546 sats (the dust threshold for outputs a wallet will track). Token outputs by convention hold 1 sat; that is separate from this rule.
- Server-built change under about 50 sats is cheaper to give to the fee than to track.
- Cap fees only where an overpay would harm a counterparty. A cap that a correctly sized transaction can exceed blocks honest use and protects nobody.

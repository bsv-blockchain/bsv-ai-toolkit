---
title: WhatsOnChain usage limits
verified: 2026-10-22
source: "@bsv/mcp content"
---

# WhatsOnChain

WhatsOnChain (WoC) is a block explorer and indexer. Arcade answers for any transaction you know the txid of; use WoC only for questions Arcade cannot answer, because Arcade has no address or outpoint index. Base URLs per network are in the `networks` facts.

## Allowed endpoints

| Endpoint | Use it for |
| --- | --- |
| `GET /address/{a}/unspent` | Coins at an address (Arcade has no address index). |
| `GET /tx/{txid}/{vout}/spent` | Who spent an outpoint, including unconfirmed spenders. |
| `GET /chain/info` | Tip height (`blocks`). |
| `GET /tx/{txid}/proof/tsc` | A merkle proof, when you do not already hold one. |
| `GET /tx/{txid}/hex` | Only for a transaction Arcade never saw. For anything you broadcast, ask Arcade, and build BEEF from the BEEFs you already hold. |

Never use WoC as the source of truth for a txid you know, and never walk a transaction's ancestry one parent at a time from WoC.

## Rate limits

- The free tier allows about 3 requests per second per IP; above that WoC answers HTTP 429.
- Route every WoC call in a process through one shared gate that spaces requests at least 350 ms apart, and back off on 429. One gate per process, not one per module.
- An optional `WOC_API_KEY` raises the limit. Send it as the raw value of the `Authorization` header (no `Bearer` prefix).
- Give every call a per-request timeout.

## Traps

- `GET /tx/{txid}/hex` can 404 for a fresh unconfirmed transaction. That means "not indexed yet", not "does not exist".
- `/address/{a}/unspent` keeps listing coins that an unconfirmed transaction has already spent, until that transaction is mined. Expect `UTXO_SPENT` from Arcade if you try to spend one; check `/tx/{txid}/{vout}/spent` first.
- Check that any hex WoC returns hashes to the txid you asked for before you use it.
- WoC indexes an unconfirmed spend 6–12 s after broadcast (measured on testnet, Oct 2026). Arcade reports the same transaction within 0.5–2 s, so gate on Arcade.

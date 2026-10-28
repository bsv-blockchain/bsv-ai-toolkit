---
title: BSV Broadcaster
verified: 2026-10-22
source: "@bsv/mcp content"
---

# BSV Broadcaster

BSV Broadcaster (formerly Arcade) is the broadcaster and transaction-status service for BSV. It replaces mAPI and the legacy ARC API: apps submit transactions to BSV Broadcaster and ask it what happened to them. Public instances need no API key. Hosts per network are listed in the `networks` facts.

## Name and versions

Verified 2026-10-28.

- **Rename.** Arcade is now BSV Broadcaster. The rename shipped in v0.19.0, released 2026-10-26.
- **Repository.** `github.com/bsv-blockchain/broadcaster`; GitHub redirects `bsv-blockchain/arcade` to it. The API is described by `openapi/bsv-broadcaster.openapi.yaml` there.
- **Docs.** `https://docs.bsvblockchain.org/broadcasting/bsv-broadcaster` and `https://docs.bsvblockchain.org/broadcasting/broadcasting`. The repository's `docs/migration-arcade-to-bsv-broadcaster.md` lists every renamed setting, path and image.
- **Names that did not change.** The public hostnames (`arcade-us-1`, `arcade-eu-1`, `arcade-ap-1`, `arcade.gorillapool.io`, and the testnet and ttn hosts in `versions.json`); the ARC error codes; the Python SDK classes `Arcade` and `ArcadeConfig`.
- **Webhook User-Agent.** Servers from v0.19.0 send `bsv-broadcaster-webhook/<version>`; older ones send `arcade-webhook/<version>`. A receiver that allowlists callbacks by User-Agent must allow both prefixes while public instances still run older releases.
- **Self-hosting, from v0.19.0.** Binary `bsv-broadcaster`; image `ghcr.io/bsv-blockchain/broadcaster`; config directory `/etc/bsv-broadcaster`; environment prefix `BSV_BROADCASTER_*`. The old `ARCADE_*` variables are still honored but deprecated, and an explicitly set new name wins. Prometheus metrics are now `bsv_broadcaster_*`, with no compatibility shim: update dashboards and alerts in the same change.
- **Public instances.** On 2026-10-28 every public instance reported `v0.16.0` in `GET /health`, a pre-rename release, and `arcade-ap-1` did not resolve. The docs list only the mainnet public endpoints (us-1, eu-1, ap-1 and GorillaPool); the testnet hosts are live but not in the official docs.
- **`@bsv/sdk`.** In 3.2.1 the `Teranode` broadcaster posts EF bytes (`application/octet-stream`) to the URL you give it, which `POST /tx` accepts. It reports only the POST answer, which is provisional, so still read `GET /tx/{txid}` before any money decision.

## Endpoints

| Call | What it does |
| --- | --- |
| `POST /tx` | Submit one transaction. `Content-Type` is one of `text/plain` (hex; surrounding whitespace is trimmed), `application/octet-stream` (raw bytes) or `application/json` with body `{rawTx}` (hex). The transaction may be plain (raw) or Extended Format (BRC-30). BEEF (BRC-62) is rejected: convert it to EF before submitting. `@bsv/sdk` produces EF with `tx.toHexEF()` when every input carries its `sourceTransaction`. Body cap 32 MiB. |
| `POST /txs` | Submit a batch: raw transactions concatenated in one `application/octet-stream` body, no separators. Body cap 256 MiB. |
| `GET /tx/{txid}` | Current status of a transaction this instance has been given. |
| `GET /policy` | Fee rate and size limits that intake enforces (see Policy). `GET /v1/policy` is an alias. |
| `GET /health` | Liveness, the server's version, current block height and the datahubs it is using. |
| `GET /events?callbackToken=` | Server-Sent Events stream of status updates for every transaction submitted with that `X-CallbackToken`. Served by BSV Broadcaster's standalone `sse` service, not the main API; on a self-hosted instance it listens on its own port (default 8082). Sends `: keepalive` every 15 s; reconnect with `Last-Event-ID` to replay what you missed. |

Optional headers on `POST /tx` and `POST /txs`:

| Header | Meaning |
| --- | --- |
| `X-CallbackUrl` | Public HTTPS URL that BSV Broadcaster POSTs `TransactionStatus` bodies to as the transaction progresses. Private and loopback hosts are refused. |
| `X-CallbackToken` | Opaque token. Sent back as `Authorization: Bearer <token>` on every webhook, and scopes the SSE stream above. |
| `X-FullStatusUpdates` | `true` delivers every status transition; the default delivers only terminal or notable ones. |
| `X-SkipFeeValidation`, `X-SkipScriptValidation` | Skip that local check. Honored only where the operator allows it. |

Callbacks or SSE replace polling. Polling `GET /tx/{txid}` with a per-request timeout and a bounded schedule is the fallback.

## Status lifecycle

`txStatus` takes one of twelve values:

| Value | Meaning for an app |
| --- | --- |
| `UNKNOWN` | Non-final. Not a verdict; read again. |
| `RECEIVED` | BSV Broadcaster has it. Not yet on the network. |
| `SENT_TO_NETWORK` | Forwarded to nodes. Wait. |
| `ACCEPTED_BY_NETWORK` | A node accepted it. Still wait: this is one step short of the gate. |
| `SEEN_ON_NETWORK` | Seen across the network. **Safe to treat as final (0-conf)** when `competingTxs` is absent or empty. |
| `SEEN_MULTIPLE_NODES` | Later than `SEEN_ON_NETWORK`; same rule. |
| `DOUBLE_SPEND_ATTEMPTED` | Terminal. Another transaction spends the same input; `competingTxs` names it. |
| `REJECTED` | Terminal. `extraInfo` carries the reason and `status` the ARC code when classifiable. |
| `PENDING_RETRY` | Non-final. BSV Broadcaster is retrying the broadcast (`retryCount`, `nextRetryAt`). |
| `STUMP_PROCESSING` | BSV Broadcaster is assembling the block proof (a STUMP, a subtree merkle path). Past the gate. |
| `MINED` | In a block; `blockHash`, `blockHeight` and `merklePath` (BUMP, hex) are set. Never wait for this before treating a payment as final. |
| `IMMUTABLE` | Deep enough that a reorg is no longer expected. |

The single gate for every money decision: `SEEN_ON_NETWORK` or later, with no competing transaction. Earlier statuses wait; `REJECTED` and `DOUBLE_SPEND_ATTEMPTED` are terminal; `UNKNOWN` and `PENDING_RETRY` are non-final, never "dead".

A `REJECTED` reason that starts `parent rejected` names a rejected ancestor and is retryable: resubmit once the ancestor is accepted. A reason that blames inputs (`UTXO_SPENT`, `missingorspent`, "already spent") on a transaction the network had already accepted usually means it was mined or spent by itself; treat it as no verdict and read again.

## Response shapes

`POST /tx` answers:

- **202** `{txid, status, txStatus}`: `status` is the HTTP code (202) and `txStatus` the lifecycle state. A resubmission of a known txid also answers 202 and echoes the current state, which may already be `MINED`, `REJECTED` or `DOUBLE_SPEND_ATTEMPTED`. A 2xx is provisional: always read `GET /tx/{txid}` afterwards.
- **400** `{error, reason?, txid?, status?, title?, detail?, type?}`: `status` is the numeric ARC code when the failure is classifiable, with its `title`, `detail` and documentation URL `type`. A validator failure is terminal and persisted as `REJECTED`. The exception is 476 (not final), which is transient and not persisted.
- **503** with `Retry-After`: backpressure. The transaction was not queued; retrying is safe.

`GET /tx/{txid}` answers 200 with a `TransactionStatus`, or 404 when this instance has no verdict for the txid.

| `TransactionStatus` field | Notes |
| --- | --- |
| `txid`, `txStatus`, `timestamp` | Always present. |
| `status` | Numeric ARC code (460–476) recorded with a `REJECTED` verdict when classifiable; omitted otherwise. |
| `extraInfo` | Free-form detail, such as the node's rejection reason. |
| `competingTxs` | Array of conflicting txids. Omitted when there are none. |
| `blockHash`, `blockHeight`, `merklePath` | Set from `MINED` on. A mined transaction whose proof is momentarily unavailable still returns `MINED` with `merklePath` omitted; read again. |
| `rawTx` | Hex of the transaction as BSV Broadcaster holds it, in Extended Format. The OpenAPI file documents it as set "only while PENDING_RETRY"; it was observed on `MINED` transactions on testnet on 2026-10-22. Do not depend on it being present. When it is, re-read it as a plain transaction (`Transaction.fromHex(Transaction.fromHexEF(hex).toHex())`) before putting it in a BEEF: the EF form carries placeholder parents. |
| `retryCount`, `nextRetryAt` | Broadcast retry state. |
| `orphanedProofs` | Earlier block anchors superseded by a reorg, if any. |
| `callbacks` | Webhook delivery state, only when the request carries `?callbackToken=`. |

## ARC codes

| Code | Meaning | Handling |
| --- | --- | --- |
| 460 | Not Extended Format (a parent's output data is needed) | Attach `sourceTransaction` to every input and submit EF. |
| 461 | Malformed transaction or invalid unlocking script | Terminal. Fix the transaction. |
| 465 | Fee too low | Terminal for those bytes. Re-size the fee from the serialized transaction at the current `/policy` rate. |
| 466 | Conflicting transaction (`UTXO_SPENT`) | Terminal, unless the conflicting transaction is your own earlier copy. |
| 476 | Not final (nLockTime ahead of median-time-past with a non-final input) | Transient. Nothing is persisted and `GET /tx/{txid}` keeps its prior answer (404 on a first submission). Resubmit the identical transaction after the lock time passes. |

## Policy

`GET /policy` returns `{policy: {miningFee: {satoshis, bytes}, maxtxsizepolicy, maxscriptsizepolicy, maxtxsigopscountspolicy, standardFormatSupported}, timestamp}`. It always answers 200 and reflects what intake enforces.

| Network | `miningFee` | `maxtxsizepolicy` | `maxscriptsizepolicy` |
| --- | --- | --- | --- |
| testnet (`arcade-testnet-us-1`) | 1 sat / 1000 bytes | 100000000 | 100000000 |
| mainnet (`arcade-us-1`) | 100 sat / 1000 bytes | 100000000 | 100000000 |

On mainnet every datahub BSV Broadcaster reported in `/health` advertised 100 sat/kB. BSV Broadcaster's size limits track the largest limit any peer advertises, and some individual peers advertised a `maxscriptsizepolicy` of 500000 or 10000000. A script larger than 500 KB may pass BSV Broadcaster yet reach fewer nodes; test it on testnet first. `maxtxsigopscountspolicy` 4294967295 means unlimited.

## Observed timing

Measured on testnet, Oct 2026:

- `GET /tx/{txid}` returned a status 0.5–2 s after the POST in every one of 19 large broadcasts, and never 404 for a transaction that had been posted.
- `SEEN_ON_NETWORK` arrived within 3–10 s of the POST.
- BSV Broadcaster can answer 2xx to the POST and mark the transaction `REJECTED` about 20 ms later (seen as ARC 466 `UTXO_SPENT` with the competitor named). The POST answer alone proves nothing.
- A 404 means this instance never saw the transaction, including one a user's wallet broadcast through another service. Submit every transaction you care about to your own BSV Broadcaster (submission is idempotent) so you can track it.
- BSV Broadcaster has no address or outpoint index. Address listings and "who spent this outpoint" still need an indexer (see the `whatsonchain` facts).

## Version

Every public instance reported `v0.16.0` in `GET /health` on 2026-10-22, and again on 2026-10-28; the latest release is v0.19.0 (see Name and versions). The API is described by `openapi/bsv-broadcaster.openapi.yaml` in `bsv-blockchain/broadcaster`, called `openapi/arcade.openapi.yaml` before the rename (OpenAPI `info.version` 1.0.0). `@bsv/sdk` 3.2.1 has no BSV Broadcaster client that reads status: its `Teranode` broadcaster only posts, so write a small client around `POST /tx` and `GET /tx/{txid}`. The SDK's `ARC` class posts to the legacy ARC path, which BSV Broadcaster does not serve, so never use it with BSV Broadcaster.

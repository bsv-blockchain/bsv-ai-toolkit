# @bsv/mcp

An MCP server for building BSV applications with AI coding agents, testnet first: BSV Broadcaster (formerly Arcade) broadcast and status tools, a static guardrail checker, BRC and docs lookup, and dated facts served as `bsv://` resources.

Source, changelog and the companion `bsv-dev` skill: [github.com/bsv-blockchain/bsv-ai-toolkit](https://github.com/bsv-blockchain/bsv-ai-toolkit).

## Install

Claude Code:

```bash
claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp
```

Other MCP clients:

```json
{
  "mcpServers": {
    "bsv-mcp": {
      "command": "npx",
      "args": ["-y", "@bsv/mcp"],
      "env": { "BSV_NETWORK": "testnet" }
    }
  }
}
```

Requires Node 22 or later. Testnet coins: [bsvfaucet.com](https://bsvfaucet.com) (sign in with a BSV wallet; up to 10M satoshis per request, one request per 24 hours).

**Local code search (optional).** `code_search` and `find_function_definition` search local clones, and `brc_lookup` reads the BRCs clone first. Run [`setup.sh`](https://github.com/bsv-blockchain/bsv-ai-toolkit/blob/main/setup.sh) `<dir>` from the repository to shallow-clone ts-stack, BRCs, broadcaster, bsv-desktop, go-wallet-toolbox and runar, then set `BSV_REPOS_DIR=<dir>`. The server starts without it; the search tools then answer with a setup hint. [ripgrep](https://github.com/BurntSushi/ripgrep) is used when installed, `grep` otherwise.

## Tools

| Tool | Input | What it does |
| --- | --- | --- |
| `broadcaster_submit` | `hex`, `broadcasterUrl?`, `network?`, `waitForSeen?` (true), `timeoutMs?` (15000), `callbackUrl?`, `callbackToken?`, `fullStatusUpdates?` | Broadcasts raw or EF hex to BSV Broadcaster `POST /tx` (refuses BEEF: convert to EF or raw first); a 2xx is provisional, so it re-reads `GET /tx/{txid}` and, with `waitForSeen`, polls until `SEEN_ON_NETWORK` or later with no competing tx, or the timeout. Returns `txid`, `txStatus`, `verdict`, `competingTxs`. |
| `broadcaster_status` | `txid`, `broadcasterUrl?`, `callbackToken?` | Reads `GET /tx/{txid}` with a `verdict` and `isFinalForApp`; a 404 means this instance was never given the txid (no verdict, not a rejection). Says whether `rawTx` is EF or raw. |
| `broadcaster_policy` | `broadcasterUrl?` | Reads `GET /policy`, with the mining fee as `satPerKb`. |
| `broadcaster_health` | `broadcasterUrl?` | Reads `GET /health` (version, block height, upstream nodes). |
| `check_guardrails` | `path` (absolute), `shape?` (`A`, `B`, `auto`), `include?`, `exclude?` | Statically checks a project against the guardrails and returns findings (`id`, `severity`, `file`, `line`, `fix`, `ref: bsv://guardrails#G-xx`) plus the passed, not-applicable and manual-checklist ids. Read-only: never edits files. Rejects a relative path. |
| `brc_lookup` | `brc` (`29`, `0029`, `BRC-29`) | Returns a BRC as Markdown: local clone first (`$BSV_REPOS_DIR/BRCs`), GitHub fallback (`bsv-blockchain/BRCs`). |
| `versions_check` | none | Compares the pinned stack with npm `latest`, the Rúnar git head, the latest BSV Broadcaster release and the version every known testnet and mainnet host reports; one row per item with drift and age. A check that fails counts as drift. |
| `docs_url` | `id` (e.g. `guides.payments`) | Resolves a docs id from `bsv://docs/index` to a live page and its Markdown URL, trying each docs host and then the legacy URL; a "Page Not Found" body counts as a miss. |
| `code_search` | `query`, `repository_name?`, `file_extension?` | Regex search with ripgrep (`grep` fallback) over the clones under `BSV_REPOS_DIR`; first matching line per file. |
| `find_function_definition` | `function_name`, `repository_name?` | Finds likely definitions of a function, method or constant (TypeScript, JavaScript, Python, Go, Rust, Java) under `BSV_REPOS_DIR`, searching `src/`, `lib/` and `source/` first. |

A transaction is final for an app at `SEEN_ON_NETWORK` or later with no `competingTxs` (`isFinalForApp`). Never wait for `MINED`.

Suppress a `check_guardrails` finding with `// bsv-guardrail-ignore G-xx reason` (or the `#`, `<!--`, `/*` comment forms) on the flagged line or the line above.

For repo maintainers, `node packages/mcp/build/cli/versions-check.js [--json] [--max-age-days N]` (after `pnpm build`) prints the `versions_check` table and exits 1 on drift or on a verified date older than N days (default 60). With `GITHUB_TOKEN` set, it sends that token to `api.github.com` (and nowhere else) to lift GitHub's unauthenticated rate limit.

## Resources

Each Markdown resource starts with `verified: YYYY-MM-DD` and `source: @bsv/mcp v<version>`; `bsv://docs/index` is JSON carrying the same two fields.

- `bsv://facts/{bsv-broadcaster,networks,whatsonchain,wallet-limits,consensus,fees,runar,tokens-1color,versions,payment-channels}`: dated facts
- `bsv://guardrails`: every guardrail `G-01`..`G-38`; template `bsv://guardrails{#id}` serves one, e.g. `bsv://guardrails#G-09` (the `ref` on each finding)
- `bsv://custody-shapes`, `bsv://threat-model`
- `bsv://docs/index`: docs ids for `docs_url`
- `bsv://simple/api`, `bsv://simple/gotchas`: `@bsv/simple` 0.7
- template `bsv://brc/{id}`: a BRC as Markdown, e.g. `bsv://brc/0029` (upstream text, no `verified:` prefix)

## Prompts

- `review_against_guardrails(path)`: run `check_guardrails`, fix the errors, walk the manual checklist
- `tokenize_with_1color(mode: deploy|transfer|mint, assetId?)`: BRC-162 1Color output encoding guidance
- `integrate_simple(framework: next|express|react|node)`: add `@bsv/simple`, testnet first
- `add_simple_feature(feature: payments|tokens|inscriptions|messagebox|certificates|did|overlay)`
- `debug_simple(symptom)`: diagnose against the known gotchas

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BSV_NETWORK` | `testnet` | `testnet` or `mainnet`. Picks the default BSV Broadcaster and gates mainnet broadcast. Any other value stops the server at startup. |
| `BSV_BROADCASTER_URL` | per network | BSV Broadcaster base URL. Defaults: testnet `https://arcade-testnet-us-1.bsvblockchain.tech`, mainnet `https://arcade-us-1.bsvblockchain.tech`. Any URL is accepted, including `http://localhost:8080`, except a known host of the other network (or an unparseable URL), which stops the server at startup. |
| `ARCADE_URL` | unset | Deprecated: the old name of `BSV_BROADCASTER_URL`. Read only when `BSV_BROADCASTER_URL` is unset, and then the server logs `ARCADE_URL is deprecated; use BSV_BROADCASTER_URL` on stderr. |
| `BSV_MCP_ALLOW_MAINNET_BROADCAST` | unset | `1` lets `broadcaster_submit` broadcast on mainnet. |
| `BSV_REPOS_DIR` | unset | Directory filled by `setup.sh`. Needed by `code_search` and `find_function_definition`; `brc_lookup` reads the `BRCs` clone there first. |
| `WOC_API_KEY` | unset | Optional WhatsOnChain key, reserved for `versions_check`; no tool sends it today. |
| `BSV_MCP_NETWORK_TESTS` | unset | Test suite only: `1` enables the tests that call live services. |

An empty value, or an unresolved plugin placeholder such as `${user_config.broadcaster_url}`, counts as unset.

## Safety

- **Testnet by default.** Mainnet is real money and is used only when you configure it.
- **Set `BSV_NETWORK=mainnet` for any mainnet BSV Broadcaster**, including custom and self-hosted hosts. The server gates mainnet broadcast on the configured network, not on the URL: it refuses known mainnet hosts while on testnet, but it cannot classify a host it does not know, so an unknown mainnet BSV Broadcaster under `BSV_NETWORK=testnet` would be treated as testnet.
- **Mainnet broadcast needs a second switch.** On mainnet, `broadcaster_submit` also requires `BSV_MCP_ALLOW_MAINNET_BROADCAST=1`; without it the tool returns an error before contacting BSV Broadcaster.
- **Network and host must agree.** A `BSV_BROADCASTER_URL` that is a known host of the other network stops the server at startup, and `broadcaster_submit` refuses a `broadcasterUrl` that is a known host of the other network. The Teranode test network host (`arcade-v2-ttn-us-1.bsvblockchain.tech`) is neither testnet nor mainnet; it is accepted only when you name it, with a warning. Read-only tools (`broadcaster_status`, `broadcaster_policy`, `broadcaster_health`) may query any BSV Broadcaster.
- **No keys.** No tool takes, stores or signs with a private key, WIF or seed phrase; `broadcaster_submit` broadcasts transactions that are already signed. `check_guardrails` only reads the project.

## License

MIT

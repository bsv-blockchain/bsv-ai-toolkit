# BSV AI DevKit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

Tools and dated knowledge for building BSV applications with AI coding agents, testnet first. This repository holds the `@bsv/mcp` server, the `bsv-dev` agent skill, the content both of them serve, and sample apps.

## What is here

| Path | What it is |
| --- | --- |
| `content/` | The single source of facts and rules: dated facts (`facts/*.md`), the guardrails `G-01`..`G-38` (`guardrails.yaml`), pinned versions (`versions.json`), the docs index, custody shapes and the threat model. Facts are edited here and nowhere else. |
| `packages/mcp/` | `@bsv/mcp` 2.0.0, the MCP server. `packages/mcp/content/` is a generated snapshot of `content/` that ships in the npm package. |
| `packages/skill/` | The `bsv-dev` skill 0.1.0 and Claude Code plugin: `skills/bsv-dev/` (`SKILL.md`, the generated `references/`, assets and scripts), the commands `/bsv-review` and `/bsv-design`, and the plugin manifest, which bundles `bsv-mcp` and `bsv-docs`. Unreleased until v2.0.0 is tagged. |
| `packages/sync/` | Private build step: renders `content/` into `packages/mcp/content/` and the skill's references, and lints facts and links. |
| `samples/` | Sample apps; see [`samples/README.md`](samples/README.md). |
| `docs/` | The design spec and implementation plans (`docs/superpowers/`), the [phase-1 exit checklist](docs/evals/phase-1-exit-checklist.md) and agent evals (`docs/evals/`), the WriteChoice briefing (`docs/writechoice/`) and the `@bsv/simple-mcp` deprecation kit (`docs/deprecation/`). |
| `setup.sh` | Clones the BSV repositories that `code_search`, `find_function_definition` and `brc_lookup` read locally. |

## Install

Skill (any agent that reads Agent Skills), available once v2.0.0 is released:

```bash
npx skills add bsv-blockchain/bsv-ai-toolkit
```

Claude Code plugin (skill plus MCP), available once v2.0.0 is released:

```bash
claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv
```

MCP server only, in Claude Code:

```bash
claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp
```

`@bsv/mcp` 2.0.0 is not released yet. Until it is, `npx @bsv/mcp` resolves the 1.x release, which this README does not describe; run 2.0.0 from a clone instead (see [Development](#development)).

Other MCP clients take the same command in their JSON configuration:

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

**Local code search (optional).** `code_search` and `find_function_definition` need local clones; `brc_lookup` uses them when present. Clone them and pass the directory to the server:

```bash
./setup.sh ~/bsv-repos      # ts-stack, BRCs, arcade, bsv-desktop, go-wallet-toolbox, runar (shallow)
./setup.sh --list           # just print the repository URLs
claude mcp add bsv-mcp -e BSV_NETWORK=testnet -e BSV_REPOS_DIR="$HOME/bsv-repos" -- npx -y @bsv/mcp
```

The server starts without `BSV_REPOS_DIR`; the two search tools then answer with a hint to run `setup.sh`. Install [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for faster search; without it they fall back to `grep`.

**Testnet coins.** Get them from the faucet at [bsvfaucet.com](https://bsvfaucet.com): sign in with a BSV wallet, up to 10M satoshis per request, one request per 24 hours. Mainnet has no faucet.

## @bsv/mcp tools

| Tool | Input | What it does |
| --- | --- | --- |
| `arcade_submit` | `hex`, `arcadeUrl?`, `network?`, `waitForSeen?` (true), `timeoutMs?` (15000), `callbackUrl?`, `callbackToken?`, `fullStatusUpdates?` | Broadcasts raw or EF hex to Arcade `POST /tx` (refuses BEEF: convert to EF or raw first); a 2xx is provisional, so it re-reads `GET /tx/{txid}` and, with `waitForSeen`, polls until `SEEN_ON_NETWORK` or later with no competing tx, or the timeout. Returns `txid`, `txStatus`, `verdict`, `competingTxs`. |
| `arcade_status` | `txid`, `arcadeUrl?`, `callbackToken?` | Reads `GET /tx/{txid}` with a `verdict` and `isFinalForApp`; a 404 means this Arcade was never given the txid (no verdict, not a rejection). Says whether `rawTx` is EF or raw. |
| `arcade_policy` | `arcadeUrl?` | Reads `GET /policy`, with the mining fee as `satPerKb`. |
| `arcade_health` | `arcadeUrl?` | Reads `GET /health` (version, block height, upstream nodes). |
| `check_guardrails` | `path` (absolute), `shape?` (`A`, `B`, `auto`), `include?`, `exclude?` | Statically checks a project against the guardrails and returns findings (`id`, `severity`, `file`, `line`, `fix`, `ref: bsv://guardrails#G-xx`) plus the passed, not-applicable and manual-checklist ids. Read-only: never edits files. Rejects a relative path. |
| `brc_lookup` | `brc` (`29`, `0029`, `BRC-29`) | Returns a BRC as Markdown: local clone first (`$BSV_REPOS_DIR/BRCs`), GitHub fallback (`bsv-blockchain/BRCs`). |
| `versions_check` | none | Compares the pinned stack in `versions.json` with npm `latest`, the Rúnar git head and the Arcade version on every known testnet and mainnet host; one row per item with drift and age. A check that fails counts as drift. |
| `docs_url` | `id` (e.g. `guides.payments`) | Resolves a docs id from `bsv://docs/index` to a live page and its Markdown URL, trying each docs host and then the legacy URL; a "Page Not Found" body counts as a miss. |
| `code_search` | `query`, `repository_name?`, `file_extension?` | Regex search with ripgrep (`grep` fallback) over the clones under `BSV_REPOS_DIR`; first matching line per file. |
| `find_function_definition` | `function_name`, `repository_name?` | Finds likely definitions of a function, method or constant (TypeScript, JavaScript, Python, Go, Rust, Java) under `BSV_REPOS_DIR`, searching `src/`, `lib/` and `source/` first. |

A transaction is final for an app at `SEEN_ON_NETWORK` or later with no `competingTxs`; `arcade_status` reports exactly that as `isFinalForApp`. Nothing in the kit waits for `MINED`.

Suppress a `check_guardrails` finding with `// bsv-guardrail-ignore G-xx reason` (or the `#`, `<!--`, `/*` comment forms) on the flagged line or the line above.

For repo maintainers, `node packages/mcp/build/cli/versions-check.js [--json] [--max-age-days N]` (after `pnpm build`) prints the `versions_check` table and exits 1 on drift or on a verified date older than N days (default 60). With `GITHUB_TOKEN` set, it sends that token to `api.github.com` (and nowhere else) to lift GitHub's unauthenticated rate limit.

## Resources and prompts

**Resources.** Each Markdown resource starts with `verified: YYYY-MM-DD` and `source: @bsv/mcp v<version>`; `bsv://docs/index` is JSON carrying the same two fields.

| URI | Content |
| --- | --- |
| `bsv://facts/{arcade,networks,whatsonchain,wallet-limits,consensus,fees,runar,tokens-1color,versions,payment-channels}` | Dated facts, one resource per file |
| `bsv://guardrails` | Every guardrail `G-01`..`G-38`: rule, reason, custody shape, how it is checked, refs |
| `bsv://guardrails{#id}` | One guardrail, e.g. `bsv://guardrails#G-09`; this is the `ref` every finding carries |
| `bsv://custody-shapes` | Shape A (the user's wallet holds the keys) and shape B (a server wallet does) |
| `bsv://threat-model` | What a BSV app defends against, what it does not, and what it must tell users |
| `bsv://docs/index` | Docs ids, paths and titles; resolve an id with `docs_url` |
| `bsv://simple/api`, `bsv://simple/gotchas` | The `@bsv/simple` 0.7 API surface and its traps |
| `bsv://brc/{id}` | A BRC as Markdown, e.g. `bsv://brc/0029`, via the same lookup as `brc_lookup` (upstream text, no `verified:` prefix) |

**Prompts.**

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `review_against_guardrails` | `path` | Run `check_guardrails`, fix the errors, then walk the manual checklist |
| `tokenize_with_1color` | `mode` (`deploy`, `transfer`, `mint`), `assetId?` | Build BRC-162 1Color token outputs (encoding guidance only) |
| `integrate_simple` | `framework` (`next`, `express`, `react`, `node`) | Add `@bsv/simple` to a project, testnet first |
| `add_simple_feature` | `feature` (`payments`, `tokens`, `inscriptions`, `messagebox`, `certificates`, `did`, `overlay`) | Add one `@bsv/simple` feature |
| `debug_simple` | `symptom` | Diagnose a `@bsv/simple` problem against the known gotchas |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BSV_NETWORK` | `testnet` | `testnet` or `mainnet`. Picks the default Arcade and gates mainnet broadcast. Any other value stops the server at startup. |
| `ARCADE_URL` | per network | Arcade base URL. Defaults: testnet `https://arcade-testnet-us-1.bsvblockchain.tech`, mainnet `https://arcade-us-1.bsvblockchain.tech`. Any URL is accepted, including `http://localhost:8080`, except a known host of the other network (or an unparseable URL), which stops the server at startup. |
| `BSV_MCP_ALLOW_MAINNET_BROADCAST` | unset | `1` lets `arcade_submit` broadcast on mainnet. |
| `BSV_REPOS_DIR` | unset | Directory filled by `setup.sh`. Needed by `code_search` and `find_function_definition`; `brc_lookup` reads the `BRCs` clone there first. |
| `WOC_API_KEY` | unset | Optional WhatsOnChain key, reserved for `versions_check`; no tool sends it today. |
| `BSV_MCP_NETWORK_TESTS` | unset | Test suite only: `1` enables the tests that call live services. |

## Safety

- **Testnet by default.** With no configuration the server uses testnet and the testnet Arcade. Mainnet is real money and is used only when you configure it.
- **Set `BSV_NETWORK=mainnet` for any mainnet Arcade**, including custom and self-hosted hosts. The MCP gates mainnet broadcast on the configured network, not on the URL: it refuses known mainnet hosts while on testnet, but it cannot classify a host it does not know, so an unknown mainnet Arcade under `BSV_NETWORK=testnet` would be treated as testnet.
- **Mainnet broadcast needs a second switch.** On mainnet, `arcade_submit` also requires `BSV_MCP_ALLOW_MAINNET_BROADCAST=1`; without it the tool returns an error before contacting Arcade.
- **Network and host must agree.** An `ARCADE_URL` that is a known host of the other network stops the server at startup, and `arcade_submit` refuses an `arcadeUrl` that is a known host of the other network. The Teranode test network host (`arcade-v2-ttn-us-1.bsvblockchain.tech`) is neither testnet nor mainnet; it is accepted only when you name it, with a warning. Read-only tools (`arcade_status`, `arcade_policy`, `arcade_health`) may query any Arcade.
- **No keys.** No tool takes, stores or signs with a private key, WIF or seed phrase; `arcade_submit` broadcasts transactions that are already signed. `check_guardrails` only reads the project, and the prompts tell the agent never to ask for or print a key.
- **Logs.** The startup line on stderr shows the Arcade origin only, never its path, query or credentials.

## Development

Requires Node 22 or later (the tipping sample needs 22.9 or later) and pnpm. The repo pins pnpm 11.22.0 in `packageManager`; run `corepack enable` once and corepack picks that version. Node 25 and later no longer bundle corepack; there, or wherever corepack is missing, run `npm install -g pnpm@11.22.0` instead.

```bash
corepack enable            # or, on Node 25+ or without corepack: npm install -g pnpm@11.22.0
pnpm install
pnpm build                 # every package
pnpm test                  # every package; live-service tests run only with BSV_MCP_NETWORK_TESTS=1
pnpm sync                  # render content/ into packages/mcp/content and the skill references
pnpm sync:check            # exit 1 and list the paths when a generated file is out of date
pnpm check:facts           # every fact carries a verified date (--max-age-days N to bound its age)
pnpm check:links           # every URL in content/ answers (calls the network)
```

Edit facts and guardrails in `content/`, run `pnpm sync`, and commit the generated files with the change; CI fails when they drift.

To run the local build from Claude Code:

```bash
claude mcp add bsv-mcp-dev -e BSV_NETWORK=testnet -- node "$PWD/packages/mcp/build/index.js"
```

## Release

Releases are cut by pushing a tag `v<version>` that matches `packages/mcp/package.json`. The `release.yml` workflow runs on `v*` tags only: it builds, tests, checks that generated content is current, and publishes `@bsv/mcp` with npm trusted publishing (GitHub OIDC, with provenance), so no long-lived npm token exists anywhere. Pushing to `main` never publishes. Changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

What must be true before and after the first release is tracked in the [phase-1 exit checklist](docs/evals/phase-1-exit-checklist.md).

## License

MIT; see [`LICENSE.md`](LICENSE.md).

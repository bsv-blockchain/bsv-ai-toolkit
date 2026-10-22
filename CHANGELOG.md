# Changelog

One changelog for the repository: `@bsv/mcp` and the `bsv-dev` skill move together.

## 2.0.0 (unreleased)

The repository becomes a pnpm monorepo and `@bsv/mcp` is rewritten around testnet-first BSV app development.

### Added

- Monorepo layout: `content/` (single source of dated facts and guardrails), `packages/mcp`, `packages/skill`, `packages/sync`, `samples/`. Node 22 or later, pnpm workspaces.
- Arcade tools: `arcade_submit`, `arcade_status`, `arcade_policy`, `arcade_health`. `arcade_submit` refuses BEEF, treats a 2xx as provisional and re-reads `GET /tx/{txid}`; `arcade_status` reports `isFinalForApp` at `SEEN_ON_NETWORK` or later with no `competingTxs`.
- `check_guardrails`: a read-only static check of a project (absolute path) against the guardrails `G-01`..`G-34`, with fixes, refs and a manual checklist.
- `versions_check` and the `bsv-mcp-versions-check` command: pinned versions against npm, the Rúnar git head and every known Arcade host.
- `docs_url`: resolves stable docs ids to a live page across docs hosts.
- Resources: `bsv://facts/*`, `bsv://guardrails`, `bsv://guardrails{#id}`, `bsv://custody-shapes`, `bsv://threat-model`, `bsv://docs/index`, `bsv://simple/api`, `bsv://simple/gotchas`, `bsv://brc/{id}`. Every Markdown resource carries its `verified:` date.
- Prompts: `review_against_guardrails`, `tokenize_with_1color`, and, folded in from `@bsv/simple-mcp` and rewritten for `@bsv/simple` 0.7 and testnet: `integrate_simple`, `add_simple_feature`, `debug_simple`.
- Environment: `BSV_NETWORK` (`testnet` default), `ARCADE_URL`, `BSV_MCP_ALLOW_MAINNET_BROADCAST`, `WOC_API_KEY`. `arcade_submit` on mainnet needs `BSV_MCP_ALLOW_MAINNET_BROADCAST=1`, and an Arcade host known to belong to the other network is refused.

### Changed

- `brc_lookup` takes `brc` (was `brc_identifier`), accepts `29`, `0029` or `BRC-29`, searches every category directory of the local `BRCs` clone (v1 used a fixed list) and falls back to GitHub `bsv-blockchain/BRCs` when the BRC is not there.
- `code_search` and `find_function_definition` keep their inputs; the `grep` fallback now honours the file filter and skips `.git` and `node_modules`.
- The server reports the version from its own `package.json` (v1 hardcoded an older one).
- `setup.sh` clones `bsv-blockchain/ts-stack`, `BRCs`, `arcade`, `bsv-desktop`, `go-wallet-toolbox` and `icellan/runar`, prints the `BSV_REPOS_DIR` line to set, and lists the URLs with `--list`.
- Releases publish from `v*` tags with npm trusted publishing; pushing to `main` no longer publishes.

### Removed

- The hard exit when `BSV_REPOS_DIR` is missing: the server starts without it, and only the search tools ask for it.
- Prompt names with a leading `/` (`/summarize_brc`, `/explain_code`, `/generate_usage_example`, `/find_related_code`). Use `brc_lookup` or `bsv://brc/{id}` and `code_search` directly.
- The `summarize_brc` path `BRCs/brcs/<id>.md`, which does not exist in the BRCs repository.
- README text claiming `brc_lookup` fetches from GitHub (v1 read only the local clone), and the instruction to run a separate filesystem MCP server alongside.
- The `bitcoin-sv/*` clone list in `setup.sh`.

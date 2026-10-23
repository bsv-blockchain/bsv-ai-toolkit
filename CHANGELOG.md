# Changelog

One changelog for the repository: `@bsv/mcp` and the `bsv-dev` skill move together.

## 2.0.0 (unreleased)

The repository becomes a pnpm monorepo and `@bsv/mcp` is rewritten around testnet-first BSV app development.

### Added

- Monorepo layout: `content/` (single source of dated facts and guardrails), `packages/mcp`, `packages/skill`, `packages/sync`, `samples/`. Node 22 or later, pnpm workspaces.
- Arcade tools: `arcade_submit`, `arcade_status`, `arcade_policy`, `arcade_health`. `arcade_submit` refuses BEEF, treats a 2xx as provisional and re-reads `GET /tx/{txid}`; `arcade_status` reports `isFinalForApp` at `SEEN_ON_NETWORK` or later with no `competingTxs`.
- `check_guardrails`: a read-only static check of a project (absolute path) against the guardrails `G-01`..`G-38`, with fixes, refs and a manual checklist.
- content: payment-channels facts (`bsv://facts/payment-channels`) and guardrails G-35..G-38. `check_guardrails` checks G-36 (lock times in milliseconds) and G-08 (a `hashToDirectlySign` digest read from the wire) statically.
- `versions_check` and the maintainers' `node packages/mcp/build/cli/versions-check.js` script: pinned versions against npm, the Rúnar git head and every known Arcade host.
- `docs_url`: resolves stable docs ids to a live page across docs hosts.
- Resources: `bsv://facts/*`, `bsv://guardrails`, `bsv://guardrails{#id}`, `bsv://custody-shapes`, `bsv://threat-model`, `bsv://docs/index`, `bsv://simple/api`, `bsv://simple/gotchas`, `bsv://brc/{id}`. Every content resource carries its `verified:` date (`bsv://brc/{id}` serves the upstream BRC text as-is).
- Prompts: `review_against_guardrails`, `tokenize_with_1color`, and, folded in from `@bsv/simple-mcp` and rewritten for `@bsv/simple` 0.7 and testnet: `integrate_simple`, `add_simple_feature`, `debug_simple`.
- The `bsv-dev` skill and Claude Code plugin (`packages/skill`, version 0.1.0; see [`packages/skill/CHANGELOG.md`](packages/skill/CHANGELOG.md)). Install with `npx skills add bsv-blockchain/bsv-ai-toolkit` or `claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv`; the plugin bundles `@bsv/mcp@2.0.0` and the BSV docs MCP.
- Each GitHub release attaches `bsv-dev-skill.zip` (the plugin root, with `skills/bsv-dev/SKILL.md` inside). The release job builds and checks the zip before publishing to npm.
- CI job `skill`: `skills-ref validate`, `claude plugin validate --strict` on the plugin, its marketplaces and component directories, the skill tests and the anti-goal grep over the skill. Root scripts `pnpm validate:skill` and `pnpm validate:plugin` run the same checks locally.
- The tipping sample `samples/tipping-shape-a` (`bsv-tipping-demo`): custody shape A, where each user's BRC-100 wallet (such as BSV Desktop) holds the keys and signs, with a relay that holds no key and serves the web app, `/manifest.json`, `/api` and `/health` on one origin. The relay broadcasts through Arcade and reads the status there; the creator page collects each tip with `internalizeAction` at 0-conf, once Arcade reports `SEEN_ON_NETWORK` or later with no competing transaction. Testnet by default (`BSV_NETWORK`), with `GUARDRAILS.md`, `TRUST.md`, `HOSTING.md` and a testnet gate (`pnpm gate`) that runs one real tip end to end with headless wallets.
- Container image `ghcr.io/bsv-blockchain/bsv-tipping-demo` (`linux/amd64`, `linux/arm64`), built by `sample-ghcr.yml` on pushes to `main` that touch the sample and on `v*` tags; tags `latest`, `sha-<short sha>`, `<major>.<minor>.<patch>` and `<major>.<minor>`.
- CI job `sample`: builds and tests the sample, runs `node packages/mcp/build/cli/check-guardrails.js` over it (exit 1 on any `error` finding), the anti-goal grep over it, and a `linux/amd64` Docker build that pushes nothing.
- Nightly workflow (`nightly.yml`): the `freshness` job runs `versions-check`, checks that verified dates are within 60 days, checks links and compares `llms.txt` with the docs index, and opens or updates one issue, "Freshness: content drift", when any of them finds a problem. The testnet `gate` job runs `pnpm -F bsv-tipping-demo gate run` only when the `BSV_TESTNET_GATE_KEY` secret exists, uploads the gate record, and adds a section to the same issue when the gate fails.
- `docs/writechoice/`: the briefing for the WriteChoice docs team and the draft "Coding with agents" page (`coding-with-agents.md`). `community-skills.yaml` at the repository root lists community skills for that page, added by pull request with commit-pinned links; it is empty for now.
- `docs/deprecation/simple-mcp/`: the kit for retiring `@bsv/simple-mcp` (the 0.0.3 stub's files, the PR body and the steps for the owner). Nothing in it is published from this repository.
- `docs/evals/`: the phase-1 exit checklist, and the fresh-agent eval protocol (a starter React app, the prompt `add tipping to my React app on BSV`, scoring with `check_guardrails`, and a run template).
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

# Changelog: bsv-dev skill and plugin

The skill and plugin release with `@bsv/mcp` from the same `v*` tag; the repository-wide entry is in the root [`CHANGELOG.md`](../../CHANGELOG.md).

## 0.1.0 (unreleased)

### Added

- The `bsv-dev` Agent Skill (`skills/bsv-dev/SKILL.md`): an end-to-end playbook for BSV apps, testnet first, on BRC-100 wallets, BRC-29 payments, Arcade and Rúnar. Final for the app at `SEEN_ON_NETWORK` or later with no competing transaction, never `MINED`.
- References: `facts.md`, `guardrails.md`, `stack.md`, `custody-shapes.md` and `threat-model.md` generated from the repository's `content/`, plus authored files for the wallet, BRC-29 payments, Arcade, `@bsv/simple` routing, testnet to mainnet and common errors.
- `references/payment-channels.md`: when a payment channel beats per-payment BRC-29 or HTTP 402, the three constructions, how to open, update and close one, timeouts, backups and a review checklist (G-35 to G-38). Default decision 11: per-payment transactions unless two parties make many updates.
- Scripts `arcade-check.sh` and `network-guard.sh`, and assets: a manifest template, `AGENTS.md`/`CLAUDE.md` snippets, a Cursor rule, `env.example` and the install commands.
- The Claude Code plugin `bsv-dev` (marketplace `bsv`, install id `bsv-dev@bsv`): the skill, `/bsv-review [path]` and `/bsv-design [app name]`, and both MCP servers (`@bsv/mcp@2.0.0` and the BSV docs MCP). It asks for the network (default `testnet`) and an optional Arcade URL, needs Claude Code v2.1.271 or later, and never sets `BSV_MCP_ALLOW_MAINNET_BROADCAST`.
- Install: `npx skills add bsv-blockchain/bsv-ai-toolkit`, or `claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv`. Each GitHub release also carries `bsv-dev-skill.zip`.
- CI validates the skill with `skills-ref` and the plugin with `claude plugin validate --strict`, runs the structure and trigger tests, and runs the anti-goal grep over the skill.

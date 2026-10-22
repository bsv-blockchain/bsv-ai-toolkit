# Phase-1 exit checklist

Phase 1 is done when every box below is ticked and its evidence is filled in. Owner `CI` means a CI job or test proves the item on every run; `HUMAN` means a named person does it once and records the evidence here.

| # | Check | Owner | Evidence |
| --- | --- | --- | --- |
| 1 | Skill installs on a clean machine | HUMAN: Connor | |
| 2 | Claude Code plugin installs | HUMAN: Connor | |
| 3 | `@bsv/mcp@2.0.0` on npm with provenance | HUMAN: Deggen, then Connor | |
| 4 | Sample reports 0 guardrail errors | CI: job `sample` | |
| 5 | Broken copy reports each exit-criterion error | CI: `rules-broadcast.test.ts` | |
| 6 | Three fresh-agent runs pass | HUMAN: Connor | |
| 7 | Real BSV Desktop tip at 0-conf on the hosted origin | HUMAN: Connor | |
| 8 | Gate run recorded, `probeTxid` set | HUMAN: Connor | |
| 9 | `@bsv/simple-mcp` 0.0.3 published and deprecated | HUMAN: simple-mcp owner | |
| 10 | Briefing delivered to WriteChoice | HUMAN: Connor | |

## Items

- [ ] **1. `npx skills add bsv-blockchain/bsv-mcp` works on a clean machine.**
  Owner: HUMAN: Connor.
  On a machine (or user account) with no earlier install of the skill, run `npx skills add bsv-blockchain/bsv-mcp` and check that the agent lists the `bsv-dev` skill.
  Evidence: date, OS, Node version, the command's output.

- [ ] **2. `claude plugin marketplace add bsv-blockchain/bsv-mcp && claude plugin install bsv-dev@bsv` works.**
  Owner: HUMAN: Connor.
  Run it in Claude Code, then check that the skill, the commands `/bsv-review` and `/bsv-design`, and both MCP servers (`bsv-mcp`, `bsv-docs`) are present.
  Evidence: date, `claude --version`, `claude mcp list` output.

- [ ] **3. `@bsv/mcp@2.0.0` is on npm with provenance.**
  Owner: HUMAN: Deggen (trusted publisher), then Connor tags `v2.0.0`.
  Deggen configures npm trusted publishing for `@bsv/mcp`, naming this repository and the workflow file `release.yml`, with no environment. Connor then tags `v2.0.0` on `main`, and `release.yml` publishes (see [Release](../../README.md#release)). Check with `npm view @bsv/mcp@2.0.0 dist.attestations`.
  Evidence: the `release.yml` run URL and the `npm view` output.

- [ ] **4. `check_guardrails` on `samples/tipping-shape-a` reports 0 errors.**
  Owner: CI, job `sample` in `.github/workflows/ci.yml`.
  The job runs `node packages/mcp/build/cli/check-guardrails.js "$GITHUB_WORKSPACE/samples/tipping-shape-a"`, which exits 1 on any `error` finding.
  Evidence: a green `sample` run on the release commit.

- [ ] **5. The broken copy reports each of ARC class, `isAuthenticated`, mainnet default, WoC ancestry loop, missing manifest.**
  Owner: CI, `packages/mcp/test/rules-broadcast.test.ts`, test `exit-criterion set is all errors`.
  The test checks the `broken-a` fixture and requires at least one finding, every one of severity `error`, for each of the five.
  Evidence: a green `build-test` run on the release commit.

- [ ] **6. Three fresh-agent runs pass with zero errors, transcripts in `docs/evals/`.**
  Owner: HUMAN: Connor.
  Follow the [fresh-agent protocol](README.md#fresh-agent-protocol): three separate sessions, each in a new starter app, each passing with zero `error` findings.
  Evidence: links to the three `docs/evals/2026-MM-DD-run-N.md` records.

- [ ] **7. A real BSV Desktop tip on testnet lands in the creator's wallet at 0-conf on the hosted origin.**
  Owner: HUMAN: Connor.
  This runs after the hosting team deploys the sample per [`samples/tipping-shape-a/HOSTING.md`](../../samples/tipping-shape-a/HOSTING.md), on testnet and with `CREATOR_IDENTITY_KEY` set to the creator wallet's identity key.
  1. Open the hosted `/creator` with the creator wallet and connect.
  2. Open `/` with a second BSV Desktop profile on testnet and connect.
  3. Tip 1000 sats and approve the payment in BSV Desktop.
  4. Observe "received" on the creator page within seconds, and the sats in the creator wallet without waiting for a block.
  Evidence: the hosted origin, the txid, the time from approval to "received" and to the sats showing in the creator wallet.

- [ ] **8. Gate run recorded and `probeTxid` set.**
  Owner: HUMAN: Connor.
  The commands are in the sample's [Testnet gate](../../samples/tipping-shape-a/README.md#testnet-gate) section. In order:
  1. `pnpm -F bsv-tipping-demo gate init` creates the gate's root key in `~/.bsv-gate/tipping-shape-a.key` (or `$BSV_GATE_KEY_FILE`) and prints the funding address. It never prints the key.
  2. Fund the printed testnet address from [bsvfaucet.com](https://bsvfaucet.com) (sign in with a BSV wallet). Optionally, once the faucet transaction is visible, `pnpm -F bsv-tipping-demo gate sweep --txid <faucet txid>` proves it is spendable.
  3. `BSV_MCP_NETWORK_TESTS=1 pnpm -F bsv-tipping-demo gate run` runs one tip end to end, writes the record `docs/evals/gate-<time>.md` and, on a pass, prints `probeTxid: <txid>`.
  4. Set the repository secret `BSV_TESTNET_GATE_KEY` to the key file's contents (Settings, Secrets and variables, Actions; or `gh secret set BSV_TESTNET_GATE_KEY < ~/.bsv-gate/tipping-shape-a.key`, which never shows it). The nightly `gate` job runs only when this secret exists.
  5. Put the printed txid in `content/versions.json` at `services.arcade.probeTxid`, run `pnpm sync`, and commit it with the gate record.
  Evidence: the committed `docs/evals/gate-<time>.md`, the `probeTxid` commit, and a green nightly `gate` run.

- [ ] **9. `@bsv/simple-mcp` 0.0.3 published and deprecated.**
  Owner: HUMAN: simple-mcp owner.
  The PR, files and steps are in [`docs/deprecation/simple-mcp/`](../deprecation/simple-mcp/README.md). `@bsv/mcp` 2.0.0 must be on npm (item 3) before the deprecation PR merges, because the stub and the deprecation message send users to it.
  Evidence: the merged PR, `npm view @bsv/simple-mcp version` showing `0.0.3`, and `npm view @bsv/simple-mcp deprecated`.

- [ ] **10. Briefing delivered to WriteChoice.**
  Owner: HUMAN: Connor.
  Send [`docs/writechoice/briefing.md`](../writechoice/briefing.md) and the draft page [`coding-with-agents.md`](../writechoice/coding-with-agents.md).
  Evidence: the date sent and to whom.

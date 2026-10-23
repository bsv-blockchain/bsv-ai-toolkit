# Phase-1 exit checklist

Phase 1 is done when every box below is ticked and its evidence is filled in. Owner `CI` means a CI job or test proves the item on every run; `HUMAN` means a named person does it once and records the evidence here.

| # | Check | Owner | Evidence |
| --- | --- | --- | --- |
| 0 | `push.yaml` and `npm-publish.yml` deleted in this PR; Deggen confirms | HUMAN: Connor, before merge | |
| 1 | Skill installs on a clean machine (after item 3) | HUMAN: Connor | |
| 2 | Claude Code plugin installs (after item 3) | HUMAN: Connor | |
| 3 | `@bsv/mcp@2.0.0` on npm with provenance | HUMAN: Deggen, then Connor | |
| 4 | Sample reports 0 guardrail errors | CI: job `sample` ("Sample (bsv-tipping-demo)") | |
| 5 | Broken copy reports each exit-criterion error | CI: job `build-test` ("Build and test"), `rules-broadcast.test.ts` | |
| 6 | Three fresh-agent runs pass | HUMAN: Connor | |
| 7 | Real BSV Desktop tip at 0-conf on the hosted origin | HUMAN: Connor | |
| 8 | Gate run recorded, `probeTxid` set | HUMAN: Connor | |
| 9 | `@bsv/simple-mcp` 0.0.3 published and deprecated | HUMAN: simple-mcp owner | |
| 10 | Briefing delivered to WriteChoice | HUMAN: Connor | |
| 11 | Authored `why` text in `content/guardrails.yaml` read | HUMAN: Connor, before the `v2.0.0` tag (item 3) | |
| 12 | Repository renamed to `bsv-blockchain/bsv-ai-toolkit` | HUMAN: Connor, with Deggen, before the PR merges | |

## Items

- [ ] **0. `push.yaml` and `npm-publish.yml` are deleted in this PR, and Deggen agrees before it merges.**
  Owner: HUMAN: Connor, before the PR merges.
  The PR that adds `ci.yml`, `nightly.yml`, `release.yml` and `sample-ghcr.yml` deletes `.github/workflows/push.yaml` and `.github/workflows/npm-publish.yml`, so a merge to `main` never triggers a publish. Check that neither file is on the branch, then confirm with Deggen, who ran the go-broadcast sync that brought `push.yaml` in, that the sync is no longer active and nothing else depends on either workflow.
  Evidence: the branch's `.github/workflows/` listing, and the date and channel of Deggen's confirmation.

- [ ] **1. `npx skills add bsv-blockchain/bsv-ai-toolkit` works on a clean machine.**
  Owner: HUMAN: Connor. After item 3: the skill installs from this repository once v2.0.0 is released.
  On a machine (or user account) with no earlier install of the skill, run `npx skills add bsv-blockchain/bsv-ai-toolkit` and check that the agent lists the `bsv-dev` skill.
  Evidence: date, OS, Node version, the command's output.

- [ ] **2. `claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv` works.**
  Owner: HUMAN: Connor. After item 3: the plugin pins `@bsv/mcp@2.0.0`, so it installs only once v2.0.0 is released.
  Run it in Claude Code, then check that the skill, the commands `/bsv-review` and `/bsv-design`, and both MCP servers (`bsv-mcp`, `bsv-docs`) are present.
  Evidence: date, `claude --version`, `claude mcp list` output.

- [ ] **3. `@bsv/mcp@2.0.0` is on npm with provenance.**
  Owner: HUMAN: Deggen (trusted publisher), then Connor tags `v2.0.0` (after item 11).
  Deggen configures npm trusted publishing for `@bsv/mcp`, naming this repository and the workflow file `release.yml`, with no environment. Connor then tags `v2.0.0` on `main`, and `release.yml` publishes (see [Release](../../README.md#release)). Check with `npm view @bsv/mcp@2.0.0 dist.attestations`.
  Evidence: the `release.yml` run URL and the `npm view` output.

- [ ] **4. `check_guardrails` on `samples/tipping-shape-a` reports 0 errors.**
  Owner: CI, job `sample` ("Sample (bsv-tipping-demo)") in `.github/workflows/ci.yml`.
  The job runs `node packages/mcp/build/cli/check-guardrails.js "$GITHUB_WORKSPACE/samples/tipping-shape-a"`, which exits 1 on any `error` finding.
  Evidence: a green `sample` job on the release commit.

- [ ] **5. The broken copy reports each of ARC class, `isAuthenticated`, mainnet default, WoC ancestry loop, missing manifest.**
  Owner: CI, `packages/mcp/test/rules-broadcast.test.ts`, test `exit-criterion set is all errors`.
  The test checks the `broken-a` fixture and requires at least one finding, every one of severity `error`, for each of the five.
  Evidence: a green `build-test` job ("Build and test", `.github/workflows/ci.yml`) on the release commit.

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
  4. Set the repository secret `BSV_TESTNET_GATE_KEY` to the key file's contents (Settings, Secrets and variables, Actions; or `gh secret set BSV_TESTNET_GATE_KEY < "${BSV_GATE_KEY_FILE:-$HOME/.bsv-gate/tipping-shape-a.key}"`, the same path `init` used, which never shows it). The nightly `gate` job runs only when this secret exists.
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

- [ ] **11. Connor has read the authored `why` text in `content/guardrails.yaml`.**
  Owner: HUMAN: Connor, before the `v2.0.0` tag (item 3).
  Each guardrail's `why` is authored prose that ships in `@bsv/mcp` and the skill. Read every `why` in `content/guardrails.yaml` for accuracy and tone; fix any in `content/`, then run `pnpm sync`.
  Evidence: the date read and the commit of any fix (or "no changes").

- [ ] **12. The repository is renamed from `bsv-blockchain/bsv-mcp` to `bsv-blockchain/bsv-ai-toolkit`.**
  Owner: HUMAN: Connor, after Deggen agrees, before the PR merges and before item 3.
  Every install command, link and manifest on this branch already names `bsv-blockchain/bsv-ai-toolkit`, so they resolve only after the rename. Check with Deggen first that the org workflow sync (item 0) and any other automation keyed to the old name are handled, and set up the npm trusted publisher (item 3) under the new name. Rename in Settings → General (or `gh repo rename bsv-ai-toolkit -R bsv-blockchain/bsv-mcp`); GitHub redirects the old URLs. Then update local clones with `git remote set-url origin git@github.com:bsv-blockchain/bsv-ai-toolkit.git`.
  Evidence: the date of the rename and of Deggen's confirmation.

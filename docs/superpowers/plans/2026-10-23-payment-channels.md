# BSV AI DevKit: payment channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the kit what a payment channel is on BSV today, when one is worth building and when per-payment BRC-29 transactions or HTTP 402 are the better answer, which constructions work on Arcade and Teranode and which do not (with the reason), and the guardrails a channel must pass. Ship it as one dated fact file, one judgment reference, four guardrails (`G-35`..`G-38`, one of them static), the SKILL.md routing and the cross-links, with every count, test and generated file updated.

**Architecture:** Facts go in `content/facts/payment-channels.md` (dated, served as `bsv://facts/payment-channels` and folded into the skill's generated `facts.md`). Judgment goes in the authored `packages/skill/skills/bsv-dev/references/payment-channels.md`. Rules go in `content/guardrails.yaml` as `G-35`..`G-38`; `G-36` gets a static rule in `packages/mcp/src/lint/rules/g36.ts`. Nothing is copied from the earlier apps; every fact below carries its source.

**Tech Stack:** Markdown + YAML frontmatter, zod schemas in `packages/sync`, vitest, the `check_guardrails` rule engine (`packages/mcp/src/lint`).

**Spec:** `docs/superpowers/specs/2026-10-22-bsv-ai-devkit-design.md` §5.2 (resources), §6.1–6.2 (SKILL.md, references), §7 (guardrails). Plans 1a and 1b define the schema, sync outputs and test layout used here.

## Decisions (Connor, 2026-10-23)

1. The skill description gains `"payment channel"` (and the spec §6.1 block with it).
2. Task 3 is in scope: `G-08` gains its static heuristic.
3. Construction A (one-way payment channel) stays in the reference, marked "not run on testnet by BSVA".
4. SV Node's time-locked pool gets one row: policy you cannot reach through Arcade; do not build on it.
5. `G-36` is severity `error`.

## Global Constraints

- Branch `feat/bsv-ai-devkit-p1`; every task ends with a commit ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The repo is public. No file written here names the earlier apps, carries a local path, or copies their code. Where evidence comes from them, write "verified on testnet in BSVA's earlier apps, Oct 2026". Implementation pointers live only in the private brief (`.superpowers/sdd/payment-channels/private-sources.md`, git-ignored); read it before each task, never cite it in a commit or a file.
- Every fact in `content/` carries a source in prose and the file carries `verified: 2026-10-23`. A fact you cannot source stays out, or is written as "not verified".
- Anti-goals still hold: nothing waits for confirmations, nothing uses ARC or WhatsOnChain as truth for a known txid, nothing recommends npm Rúnar 0.4.x. `bash scripts/anti-goals.sh` must stay clean (a forbidden phrase may appear only on a "never do this" line).
- Guardrail ids are two-digit and contiguous: the new ones are exactly `G-35`, `G-36`, `G-37`, `G-38`, appended in order. The lint, the resource title, the README, the CHANGELOG, SKILL.md, both commands and the tests all say `G-01`..`G-38` afterwards.
- SKILL.md frontmatter must stay byte-identical to the spec §6.1 YAML block (structure test). Any change to the description is made in both places in the same commit.
- Generated files (`packages/mcp/content/**`, the skill's `facts.md`, `guardrails.md`, `stack.md`, `custody-shapes.md`, `threat-model.md`) are regenerated with `pnpm sync` and committed with the change; `pnpm sync:check` must pass.
- Verification after every task: `pnpm build && pnpm test`, `pnpm sync:check`, `bash scripts/anti-goals.sh`. After the content tasks also `pnpm check:facts`; once at the end `pnpm check:links` (network) and `npx -y skills-ref@0.1.5 validate packages/skill/skills/bsv-dev`.

## The verdict the content must state

Write it once in the facts file and refer to it from the reference. Sources are in the per-file outlines.

1. **Consensus.** Post-Genesis `nSequence` is only the finality flag; a transaction with any input `nSequence < 0xffffffff` is non-final until the chain passes its `nLockTime`. There is no consensus-level replacement of one non-final version by another; once matured, every signed version spending the outpoint is equally valid and the first one seen wins.
2. **Arcade** (the only broadcaster the kit allows) answers a non-final transaction with 400 / ARC 476, persists nothing, and `GET /tx/{txid}` stays 404 until an identical final submission. It never holds, orders or replaces channel states.
3. **Teranode** rejects a non-final transaction as invalid under its consensus rule and, in its own source, says payment channels are the user's business to run off-chain ("Teranode shouldn't be aware or care about them").
4. **SV Node** keeps a *time-locked (non-final) transaction pool* as node policy (default 50 MiB, entries expire after 4 weeks, a non-final transaction may not spend another non-final one, an update is a renegotiated version with a higher `nSequence`). It is reachable only by submitting straight to such a node; whether those transactions are relayed is not verified. An app that broadcasts through Arcade never touches it.
5. **Therefore** the wiki's option 1, "public, managed by the mining network", is not available to an app built with this kit. Options 2 and 3, private channels where the parties hold every state off-chain and only final transactions reach Arcade, are what works, and what BSVA's earlier apps ran on testnet in Oct 2026 in two forms: a referee channel (two parties plus an operator key) and a trustless covenant channel (a Rúnar contract judges the state). A third form, the one-way payment channel for metered service, follows from the same mechanics and the wiki's streaming example but has not been run on testnet by BSVA; the reference says so.
6. **Stale-state defence** on BSV is therefore not replacement but ordering plus first-seen: the newest state carries the earliest `nLockTime` (or the earliest height on a schedule), the holder posts it the moment it matures (retrying every few minutes on 476 while median-time-past catches up), and an older state broadcast later is a double spend that Arcade reports `REJECTED` 466 `UTXO_SPENT` with the competitor named.

---

### Task 1: Facts and guardrails in `content/`, lint count, generated files

**Files:**
- Create: `content/facts/payment-channels.md`
- Modify: `content/guardrails.yaml` (append `G-35`..`G-38`; header comment `G-01..G-38`), `packages/sync/src/lint.ts` (`GUARDRAIL_IDS` length 34 → 38, message text), `packages/sync/test/lint.test.ts` (test name and expectation), `README.md` (two `G-34` mentions), `CHANGELOG.md`
- Regenerate: `packages/mcp/content/**`, `packages/skill/skills/bsv-dev/references/{facts,guardrails}.md`

**`content/facts/payment-channels.md` outline** (frontmatter `title: Payment channels`, `verified: 2026-10-23`, `source: "@bsv/mcp content"`; H1 `# Payment channels`):

1. `## What a channel is on BSV`. Two parties fund one output, then exchange signed transactions spending it off-chain, updating the balance or state, and broadcast only the final version; funds return after a fixed time if a party goes silent. Source: the wiki page `https://wiki.bitcoinsv.io/index.php/Payment_Channels` (its definition: a transaction with `nSequence < 0xffffffff` and a future `nLockTime`, updated between peers until the lock time arrives or the sequence is finalised). State the wiki's three management options verbatim as labels (public via the mining network; private with one pre-funded UTXO per channel; private with separate channels per user) and say which work today (section 3).
2. `## Sequence numbers, lock times and finality`. `nSequence == 0xffffffff` on every input, or `nLockTime == 0`, makes a transaction final at once; otherwise it is final only when `nLockTime` is strictly less than the height (if `< 500000000`) or the median-time-past (otherwise) of the block that would mine it, so a transaction with `nLockTime = H` is mineable from block `H + 1`. MTP lags the clock by up to about an hour. No relative lock times (BIP68 and `OP_CHECKSEQUENCEVERIFY` are NOPs). No consensus replacement by a higher `nSequence`. Sources: `consensus` facts (already verified 2026-10-22); the Teranode validator helper `util/lock_time.go` in `bsv-blockchain/teranode` (read 2026-10-23: "a transaction is final only when lockTime is strictly less than the comparison height/time").
3. `## Who holds a non-final transaction today` as a table with three rows and a conclusion:
   - Arcade: 400 with ARC code 476, "no verdict is persisted", `GET /tx/{txid}` 404 after a 476-only submission, resubmit the identical transaction once final. Sources: `openapi/arcade.openapi.yaml` in `bsv-blockchain/arcade` (read 2026-10-23); the `arcade` facts; verified on testnet in BSVA's earlier apps, Oct 2026 (a server-side fallback that retried every 5 minutes on 476).
   - Teranode: rejects a non-final transaction as invalid (consensus rule TNJ-13 in `util/lock_time.go`); quote the one sentence that channels are for the user to run and the node "shouldn't be aware or care about them". Source: the same file, read 2026-10-23. Mark: read from source, not probed live.
   - SV Node: time-locked transaction pool, policy not consensus, default size 50 MiB, expiry 4 weeks without an update, a non-final transaction spending another non-final one is refused, an update is a renegotiated version with a higher `nSequence`. Source: the BSV hub wiki page on transaction pools (`https://hub.bsvblockchain.org/wiki/transactions-and-utxos/bitcoin-transactions/transaction-pools`, read 2026-10-23). Mark unverified: whether such transactions are relayed between nodes, and the current defaults in SV Node releases.
   - Conclusion sentence: an app that broadcasts through Arcade cannot park a state on the network; the parties hold every state, and only final transactions are broadcast. (This is the only place the public-versus-private verdict is stated as a fact; the reference draws the consequences.)
4. `## Sighash flags a channel uses` as a table: `0x41` ALL|FORKID (commits to everything; the fee payer's own inputs and a referee's attestation); `0xc1` ALL|ANYONECANPAY|FORKID (all outputs, only this input: a balance update where the payer must see its change pinned); `0xc2` NONE|ANYONECANPAY|FORKID (only version, outpoint, scriptCode, value, this input's `nSequence` and `nLockTime`: a signature over a state carried in `nSequence` that a covenant verifies with a plain `OP_CHECKSIG`); `0xc3` SINGLE|ANYONECANPAY|FORKID (input 0 plus output 0 plus `nLockTime`: a signed record that lets whoever closes add fee inputs and change at index ≥ 1). The wiki's "SIGHASH_ANYONECANPAY | SIGHASH_NONE" is `0xc2` with FORKID. Note the checksig encoding (DER plus the sighash byte), low-S and canonical DER, and that the double SHA-256 of the BIP-143 preimage is what `createSignature({ hashToDirectlySign })` signs. Sources: BIP-143 digest in `@bsv/sdk` (`TransactionSignature.format`, `scope`); verified on testnet in BSVA's earlier apps, Oct 2026 (0xc3 and 0xc2 states validated under `Spend` and mined).
5. `## nSequence as a state carrier`. Any value below `0xffffffff` keeps `nLockTime` enforced and is otherwise free: an 18-bit state fitted in it, and a counter of updates did too; a Rúnar covenant reads it with `extractSequence` and the lock time with `extractLocktime`. Source: `runar` facts; verified on testnet in BSVA's earlier apps, Oct 2026.
6. `## Ordering states without replacement`. Two measured schedules: (a) seconds, `nLockTime = base − n × 10 s` for state `n`, which with 10-minute block granularity and MTP lag makes the ordering nominal, so the holder of every state (there, an operator) was the real enforcer; (b) heights, `T(k) = openHeight + (9 − k) × W` with `W = 6` blocks, which gives a full window between a state and its predecessor and was enough for clients to defend themselves. Stale broadcast result on testnet: `REJECTED`, ARC 466 `UTXO_SPENT`, competitor listed in `competingTxs`. The close is final (`nSequence 0xffffffff`, `nLockTime 0`) and valid at once. Sources: verified on testnet in BSVA's earlier apps, Oct 2026.
7. `## Arcade observations for channel transactions` (testnet, Oct 2026): a 1-sat channel output and a 0-sat `OP_FALSE OP_RETURN` record output were accepted; chains of unconfirmed covenant spends were accepted and mined together (nine in one block); a time-locked state posted exactly when the tip reached its lock time was never answered 476 in 19 broadcasts (the client waited for the height from an indexer first); `GET /tx/{txid}` answered 0.5–2 s after the POST; the opening reached `SEEN_ON_NETWORK` within seconds and play started at 0-conf. Source: verified on testnet in BSVA's earlier apps, Oct 2026 (the `arcade` facts carry the same timings).
8. `## Sizes and fees` (100 sat/kB, testnet, Oct 2026). Referee channel with a 1-sat output and a data record in the close: open ≈ 350 B ≈ 35 sats; close ≈ 1.8 KB ≈ 180 sats for 40 updates, about 13.5 B per update; players paid nothing. Covenant channel with a 9.6 KB script: opening 10,042–10,340 B (1,005–1,034 sats); a posted state 29.4 KB (2,945 sats); close 19.5–19.6 KB (≈ 1,970 sats); pre-signed refund 191 B (20 sats). The per-payment alternative: a wallet-built P2PKH payment 225–965 B (23–97 sats) and one wallet spend each; anchoring 80 updates as separate transactions was computed at ≈ 4,300 sats and observed at ≈ 8,000 with wallet rounding and change, plus 40 prompts. Sources: the `fees` facts (same measurements) and BSVA's earlier apps, Oct 2026.
9. `## What cannot be done on chain`. No "not after" bound on a transaction (lateness is handled by racing it with a conflicting spend, such as a pre-signed refund); script cannot read the height, so deadlines are anchored to an opening height both parties signed and every height gate also asserts `nLockTime < 500000000`; the last signer of a multi-party transaction can produce twins with different txids, so bind to "the transaction that spends coin X" (see the `consensus` facts). Sources: `consensus` facts; BSVA's earlier apps, Oct 2026.
10. `## Wallet facts for channels`. `createSignature({ hashToDirectlySign })` signs the exact 32 bytes given (the double SHA-256), silently under a level-1 protocol in a BRC-73 grouped grant, one call per state; `wallet-toolbox` keeps provided inputs first and, with `randomizeOutputs: false`, outputs in order, so a both-signed state can be published through a wallet by `createAction` with the signed channel input at index 0; whether BSV Desktop keeps that order is not verified (fallback: hand the user the signed state as a file). Sources: `wallet-limits` facts; BSVA's earlier apps, Oct 2026 (toolbox verified; Desktop self-publish not run).

**`content/guardrails.yaml` additions** (append after `G-34`, under a new comment `# Payment channels`):

```yaml
- id: G-35
  title: Channel states stay off-chain, newest first
  shape: both
  rule: "A payment channel never depends on Arcade or a node holding, ordering or replacing a non-final transaction: the parties hold every signed state; the close is final (`nSequence 0xffffffff`, `nLockTime 0`); non-final states are ordered newest-first by decreasing `nLockTime` or an earlier height on a schedule both parties signed; the newest state is posted the moment it matures, retrying on 476."
  why: "Post-Genesis `nSequence` is only a finality flag, Arcade answers a non-final transaction with 476 and persists nothing, and Teranode rejects it; the only defence against a stale state is that the newest one reaches the network first."
  detect: manual
  severity: warn
  refs: ["fact:payment-channels", "fact:consensus", "fact:arcade"]

- id: G-36
  title: Lock times in seconds or heights, never milliseconds
  shape: both
  rule: "Every `nLockTime` an app sets is an integer number of Unix seconds (`>= 500000000`) or a block height (`< 500000000`), validated in range before signing; a value derived from `Date.now()` is divided by 1000; a height gate also asserts `< 500000000`."
  why: "A millisecond lock time overflows the uint32 field and wraps to a value that can make a state final at once or lock it for years, and a timestamp passes a height comparison."
  detect: static
  severity: error
  refs: ["fact:payment-channels", "fact:consensus"]

- id: G-37
  title: Sign channel states only over the channel
  shape: both
  rule: "A state signature is `createSignature({ hashToDirectlySign })` over a digest the signer rebuilt itself from the channel outpoint, value, script, state and lock time, with an ANYONECANPAY sighash (`0xc1`, `0xc2` or `0xc3`) so whoever closes adds the fee; the signer refuses unless the channel output's value and script equal what it computed, never signs a digest received over the wire, and never signs two states at one index over one outpoint."
  why: "The preimage binds the signature to the outpoint, value and script, so a signature made for the channel can never spend a deposit or a foreign script; an ANYONECANPAY flag keeps the fee payer's inputs out of the signed data; one signature per index is what stops a rewritten history."
  detect: manual
  severity: warn
  refs: ["fact:payment-channels", "fact:consensus"]

- id: G-38
  title: Every channel has a watcher, a timeout exit and backups
  shape: both
  rule: "Each party persists, write-ahead, the opening transaction (AtomicBEEF), the channel outpoint, every signature it received and the newest state signed by both, plus any pre-signed refund; a watcher (a client tab, a bot or a server) posts the newest state at its maturity; the channel has a lifetime after which funds return without the counterparty (a pre-signed `nLockTime` refund or a covenant timeout); the payee of a one-way channel closes before that expiry with a margin for median-time-past lag."
  why: "A state nobody can produce is worthless, a state nobody posts loses to an older one, and a channel with no expiry strands funds when the counterparty disappears."
  detect: manual
  severity: warn
  refs: ["fact:payment-channels", "fact:arcade"]
```

`G-36` static heuristic (for Task 2): in non-test source files, flag a code line where a lock-time name (`lockTime`, `nLockTime`, `lockTimeBase`, `locktime`) and a millisecond clock (`Date.now()`, `.getTime()`, `performance.now()`) appear in the same statement (same line, or up to three lines within the same `(`…`)` or `{`…`}` via `bracketText`) and that statement carries no `/ 1000`, `/ 1_000`, `/1000`, `/1e3` or `Math.floor(... / 1000)`. Also flag `new Transaction(1, ..., <expr>)` when the fourth argument's text contains `Date.now()` and no division. `applicable` is `false` when no source file mentions a lock-time name (then the guardrail lands in `notApplicable`, not `passed`). Severity `error`. Suppressible with `// bsv-guardrail-ignore G-36 reason` as every rule is.

**Steps:**

- [ ] **Step 1 (RED):** in `packages/sync/test/lint.test.ts` rename the test to `requires G-01..G-38 in order` and add a second assertion: a list of exactly `G-01`..`G-34` (reuse the repo's `content/guardrails.yaml` minus the tail is awkward; instead write a temp dir with 34 valid items generated in a loop) produces an error mentioning `G-35`. Run `pnpm -F @bsv/sync test` and confirm the new assertion fails.
- [ ] **Step 2 (GREEN):** in `packages/sync/src/lint.ts` set `GUARDRAIL_IDS` length to 38 and the message to `G-01..G-38`; append the four guardrails to `content/guardrails.yaml`; update the header comment. Run `pnpm -F @bsv/sync test` and `pnpm check:facts`.
- [ ] **Step 3:** write `content/facts/payment-channels.md` from the outline. Run `pnpm check:facts`.
- [ ] **Step 4:** `pnpm sync`; confirm `packages/mcp/content/facts/payment-channels.md`, `guardrails.json` and the skill's `facts.md`/`guardrails.md` changed; `pnpm sync:check` passes.
- [ ] **Step 5:** README.md lines mentioning `G-01`..`G-34` (the `content/` row and the `bsv://guardrails` row) → `G-38`; the `bsv://facts/...` resource row gains `payment-channels`; CHANGELOG.md gains an entry under the unreleased 2.0.0 section: `content: payment-channels facts (bsv://facts/payment-channels) and guardrails G-35..G-38`.
- [ ] **Step 6:** `pnpm build && pnpm test` (expect the MCP resource and heading-count tests to fail now: that is Task 2's RED), `bash scripts/anti-goals.sh`. Commit only the sync and content packages plus README/CHANGELOG if the MCP tests fail; otherwise everything:

```bash
git add content packages/sync packages/mcp/content packages/skill/skills/bsv-dev/references/facts.md packages/skill/skills/bsv-dev/references/guardrails.md README.md CHANGELOG.md
git commit -m "feat(content): payment-channels facts and guardrails G-35..G-38

What works on Arcade, Teranode and SV Node today, the sighash flags and
lock-time schedules a channel uses, measured sizes, and four rules: states
off-chain newest-first, lock times in seconds or heights, signing only over
the channel, watcher plus timeout exit plus backups. Lint expects G-01..G-38.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: MCP resource, counts and the `G-36` static rule

**Files:**
- Modify: `packages/mcp/src/resources/index.ts` (`FACTS` gains `'payment-channels'`; doc comment "15 static" → 16; guardrails title and error text `G-01..G-38`), `packages/mcp/src/lint/rules/index.ts` (register `g36`), `packages/mcp/README.md` (resources list, `G-01..G-34` → `G-38`)
- Create: `packages/mcp/src/lint/rules/g36.ts`
- Test: `packages/mcp/test/resources-prompts.test.ts` (`STATIC_URIS` + `bsv://facts/payment-channels`; "lists all 16 static resources"; "guardrails resource has 38 headings" with `headings[37]` `G-38`; the fragment loop to 38), `packages/mcp/test/rules-broadcast.test.ts` (new `describe('G-36 lock time units')`)

**Steps:**

- [ ] **Step 1 (RED):** update `resources-prompts.test.ts` as above; add to `rules-broadcast.test.ts`, using the existing `runOn` helper and `g36` import: `flags lockTime from Date.now() without /1000` (`src/channel.ts`: `const lockTime = Date.now() + 86400` → one finding, line 1, severity error); `accepts seconds` (`Math.floor(Date.now() / 1000) + 86_400` → none); `accepts a height` (`const lockTime = tipHeight + 54` → none); `flags the fourth argument of new Transaction` (`new Transaction(1, [], [], Date.now())` → one finding); `not applicable without a lock time` (run `g36.run(...)` directly on `{ 'src/app.ts': 'export const x = Date.now()' }` and assert `applicable === false`); `clean-a lands G-36 in notApplicable` (the fixture has no lock time) and `broken-a` is unchanged. Run `pnpm -F @bsv/mcp test`; the new cases fail.
- [ ] **Step 2 (GREEN):** implement `g36.ts` per the heuristic in Task 1 (use `scan`, `matchingCodeLines`, `bracketText`, `findingList` from `util.ts`); register it; update `resources/index.ts` and the README. Run `pnpm -F @bsv/mcp build && pnpm -F @bsv/mcp test`.
- [ ] **Step 3:** `pnpm build && pnpm test`, `pnpm sync:check`, `bash scripts/anti-goals.sh`. Commit:

```bash
git add packages/mcp
git commit -m "feat(mcp): bsv://facts/payment-channels resource and static rule G-36 (lock times in seconds or heights)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3 (Connor decides; recommended): `G-08` gains a static heuristic

The channel reference makes "sign only a digest you rebuilt" the central signing rule, and the exposure is codeable. Change `G-08`'s `detect` from `manual` to `static` (severity stays `warn`) and add `packages/mcp/src/lint/rules/g08.ts`: flag `hashToDirectlySign:` whose value expression (same statement, up to five lines, via `bracketText`) is read from a wire-shaped source: an identifier chain starting `msg.`, `message.`, `req.`, `request.`, `body.`, `params.`, `payload.`, `event.data`, `data.digest`, `JSON.parse(`, `.json()`, `searchParams`, or a bare `digest` property of a function parameter named `msg|message|req|request|payload|event`. Not applicable when no file calls `createSignature(`.

- [ ] **Step 1 (RED):** tests in `rules-wallet.test.ts` with `runOn(g08, …)`: `flags hashToDirectlySign from a message` (`createSignature({ hashToDirectlySign: msg.digest, protocolID })`), `accepts a rebuilt digest` (`const digest = channelDigest(tx); await wallet.createSignature({ hashToDirectlySign: digest })`), `not applicable without createSignature`. `clean-a` must keep zero findings.
- [ ] **Step 2 (GREEN):** implement, register, flip `detect` in `content/guardrails.yaml`, `pnpm sync`, update the `G-08` row anywhere it is listed as manual (the spec §7 line stays as history; do not edit the spec for this).
- [ ] **Step 3:** full verification; commit `feat(mcp): G-08 static check for digests signed from the wire`.

### Task 4: Skill reference, SKILL.md, spec §6.1, commands, trigger corpus

**Files:**
- Create: `packages/skill/skills/bsv-dev/references/payment-channels.md`
- Modify: `packages/skill/skills/bsv-dev/SKILL.md`, `docs/superpowers/specs/2026-10-22-bsv-ai-devkit-design.md` (§6.1 YAML block only, same description), `packages/skill/commands/bsv-review.md`, `packages/skill/commands/bsv-design.md`, `packages/skill/tests/references.test.ts`, `packages/skill/tests/triggers.corpus.ts`

**`references/payment-channels.md` outline.** Header exactly as the other authored references: `# Payment channels: when, which construction, and how to close`, blank line, `Applies to: both`, `Guardrails: G-08, G-10, G-13, G-20, G-22, G-26, G-28, G-29, G-35, G-36, G-37, G-38`. Facts are cited from `facts.md` (section "Payment channels"); the reference carries judgment. Code snippets ≤ 12 lines, written fresh. Sections (`## ` headings, exact text, tested):

1. `## When a channel is worth it`. A decision table `| question | channel | per-payment BRC-29 | HTTP 402 |` with the reasons spelled out:
   - *Fees at 100 sat/kB*: a wallet-built payment costs 23–97 sats and one wallet spend; a channel costs ≈ 35 sats to open and ≈ 180 sats to close plus about 13.5 B per update when the close carries a record, so the fee saving starts around 20 updates per session and the real saving is the wallet prompt and spend per interaction, not sats.
   - *0-conf finality*: a BRC-29 payment is final at `SEEN_ON_NETWORK` within seconds, so a channel buys no finality; it buys free, instant, prompt-less updates and jointly signed state.
   - *Counterparty count*: a channel is one outpoint between two parties (plus an optional referee key). Many payers calling one server → 402 (BRC-121, `@bsv/402-pay`, `payments-brc29.md`); one payer with many requests to one server → a one-way channel; two parties updating shared state → a state channel.
   - *Update frequency and session shape*: fewer than ~20 updates, or minutes apart → per payment; per-second or per-move within one session → channel. A channel has a lifetime (its expiry) and needs both parties online to update, a watcher to post at maturity, and backups.
   - *Privacy*: only the open and the close reach the chain, so intermediate amounts and states stay between the parties unless disputed; the close may still embed a record.
   - *Cost of building*: a state builder both sides share, a signature exchange, backups, a watcher, timeout exits, a `Spend` harness and an adversarial review (G-28, G-30). Say: do not build a channel for fewer than a few dozen updates per session.
2. `## What works today`. Restate the verdict in four lines with the reasons, pointing at `facts.md`: Arcade 476 and nothing persisted; Teranode rejects; SV Node's time-locked pool is policy you cannot reach through Arcade; therefore private channels only, states held by the parties, ordering by lock time plus first-seen. One sentence on the wiki page's three options and which two apply.
3. `## Three constructions`. A table `| construction | trust | who funds | state carrier | close branches | proven |`:
   - **A. One-way payment channel** (payer → payee, metered service): a Rúnar contract with one public method `close(payerSig, payeeSig)` (or a bare 2-of-2; the kit uses the contract so the branch is named and `Spend`-tested); the payer signs every update with `0xc1` over `[payee amount_i, payer change]`, `nSequence 0xffffffff`, `nLockTime 0` (updates are final transactions the payee simply holds; the payee never gains by broadcasting an older one and the payer cannot broadcast any); the payee co-signs a refund with `nLockTime = expiry`, `nSequence 0xfffffffe` before the payer broadcasts the opening (G-20). Proven: mechanics only (each element ran on testnet in BSVA's earlier apps); the construction as a whole has not been run by BSVA. Say so.
   - **B. Two-party state channel with a referee**: operator funds a 1-sat channel output locked to a three-key contract whose methods are the closes (both parties; party one plus referee; party two plus referee); state `n` = a transaction with input 0 = channel outpoint, `nSequence = n`, output 0 = a 0-sat `OP_FALSE OP_RETURN` record, `nLockTime = base − n × step`; both parties sign `0xc3`; the referee adds a fee input and change (`0x41`) at close; operator exposure bounded by construction (open after the first irreversible step, close-fee cap, per-identity rate, daily budget). Proven on testnet, Oct 2026.
   - **C. Trustless covenant channel**: both parties co-fund (G-22) a Rúnar stateful contract that judges every exit; a state is a signature `0xc2` over `nSequence = state` at `nLockTime = T(k)` on a height schedule; exits: post or pin the newest opponent-signed state at its maturity, reply on-chain, judged close with exact pinned outputs, claim after a deadline, abandon after a horizon; a pre-signed refund of the acceptor's funding coin races a withheld opening. Proven on testnet, Oct 2026 (seven scenarios). Needs the contract references of phase 2 to build.
4. `## Open`. Steps: derive channel keys under a level-1 protocol (`[1, '<app> channel']`, `keyID` = session id, `counterparty 'self'`) so every signature is silent under the grouped grant (`wallet-brc100.md`); choose the lifetime (`expiry`, or `lockTimeBase` for decreasing schedules, or `openHeight` both parties sign for height schedules) and validate it in range (G-36); build the opening (single funder: one `createAction`; two funders: foreign input, `signAndProcess: false`, `signAction`, `multi-party-funding` in phase 2, G-22); **before** handing over any signature on a co-funded opening, build and sign the refund of your own funding coin (G-20); submit the opening as EF to your own Arcade and have both parties submit it (idempotent, G-13); sign no state until Arcade reports it `SEEN_ON_NETWORK` or later with no `competingTxs` (G-10); bind the channel to "the transaction that spends my funding coin", not to a txid seen before every signature was in (twins).
5. `## Update`. Both sides build state `n` with one pure, shared builder from the same inputs (byte-identical transactions and digests); each signs the BIP-143 double SHA-256 for input 0 with the construction's sighash via `createSignature({ hashToDirectlySign, protocolID, keyID })`; the receiver recomputes the digest, verifies the signature (canonical DER, low S, right sighash byte) against the counterparty's channel key, then persists it (G-38); states are cumulative, so a late signer signs only the newest; never sign a received digest (G-08) and never two states at one index over one outpoint (G-37); refuse to sign unless the channel output's value and script equal what you computed (G-37). A 10-line snippet showing `TransactionSignature.format({... scope, inputSequence, lockTime })` → `Hash.hash256` → `createSignature({ hashToDirectlySign })`.
6. `## Close, cooperative`. The close is final: `nSequence 0xffffffff`, `nLockTime 0`, both signatures; whoever closes adds its fee input (`0x41`) and change at index ≥ 1 (ANYONECANPAY keeps the state signatures valid); write-ahead the hex, submit EF to Arcade, gate on `GET /tx/{txid}` (`arcade-0conf.md`); collect payouts to BRC-29 keys with `internalizeAction` automatically at the gate (`payments-brc29.md`). A rejected close (fee coin spent) is rebuilt with a fresh fee input; the state signatures stay valid.
7. `## Close without the counterparty`. The watcher posts the newest state at its maturity: for seconds schedules, first attempt at `nLockTime`, retry every 5 minutes on 476 while median-time-past catches up (waiting `nLockTime + 1 h` instead gave an older state an hour to win in BSVA's earlier apps); for height schedules, wait for the tip to reach the lock time, then post (never 476'd in 19 broadcasts); one-way channel: the payee closes at least an hour before `expiry`, else the payer's refund can win the race. Timeout exits: the pre-signed refund (`nLockTime = expiry`, `nSequence 0xfffffffe`) kept by the funder; a covenant `claim` or `abandon` after a height horizon. Nothing bounds "not after" on chain: a withheld opening is beaten by broadcasting the funding refund once the agreed height passes.
8. `## Stale states and disputes`. The newest state matures first; first-seen then makes the stale one a 466 double spend (apply the two-read dead rule before concluding). Seconds schedules are nominal (10-minute blocks, MTP lag), so the holder of all states is the enforcer; height schedules with `W` blocks between states let each party defend itself; the liveness bound is inherent (no relative lock times): a party must act within `W` of a maturity point. Twin openings: a signature over opening A is void if twin B confirms; follow the confirmed spender. A server can delay, not steal, when it only relays. Every attack from a review becomes a `Spend` case (G-28).
9. `## Backups`. What: opening AtomicBEEF, outpoint/value/script/lifetime, every counterparty signature, the newest both-signed state (unlocking script ready), the pre-signed refund, the list of indices you signed per outpoint. When: write-ahead, before sending your signature; after every received signature; keep after the close until it confirms, prune after days. Where: client storage under a per-session key with a single writer per session (two tabs must not clobber each other), and the server as a second copy when there is one. Self-publish: `createAction` with the signed channel input at index 0, `inputBEEF`, `randomizeOutputs: false`; verified with `wallet-toolbox`, not with BSV Desktop (offer the state as a downloadable file as the fallback).
10. `## Rúnar for the covenant`. Only for construction C and the close methods of A and B: `checkSig` is a plain `OP_CHECKSIG` and verifies whatever sighash the signature carries, so a `0xc2` state signature verifies natively while `extractSequence` reads the state; `extractLocktime` plus `< 500000000` on every height gate (G-26); terminal methods pin outputs with `hash256(outputs) == extractOutputHash` (G-26); version-1 transactions; the script is carried three times per transition (29 KB for a 9.6 KB script), so run the testnet size gate before UI (G-29, G-33); upstream Rúnar only (G-25).
11. `## Arcade for the open and the close`. EF hex, 2xx provisional, gate on `SEEN_ON_NETWORK` with no competitor, 476 is transient and persists nothing (resubmit the identical bytes), 404 is no verdict, chains of unconfirmed spends are fine, re-post dropped transactions from stored hex, and submit everything you care about to your own Arcade including what the counterparty broadcast.
12. `## Review checklist`. Ten lines, each mapped to a guardrail, in the attack catalogue's words: stale state, rewritten history, signature bound to a foreign output, digest from the wire, milliseconds lock time, missing watcher, no expiry, no backups, twin opening, 476 treated as dead.

**SKILL.md changes:**
- Frontmatter `description`: insert `"payment channel", ` right after `"escrow on BSV", ` (771 → 790 characters, under 1024). Make the identical edit in the spec §6.1 YAML block.
- `## What this skill is for`: add a bullet `- open a payment channel between two wallets, or decide against one (per-payment BRC-29 or HTTP 402 instead);`.
- `## Default decisions`: add `11. **Per-payment transactions by default; a channel only for many updates between two parties.** A payment channel is one outpoint between two parties whose states stay off-chain and newest-first; Arcade and Teranode do not hold non-final transactions. Read `references/payment-channels.md` before proposing one.`
- Tools table `check_guardrails` row and `## Read when needed` guardrails row: `G-01`..`G-38`.
- Routing table: new row after the payments row: `| Many small payments or a jointly signed state between two parties: when a channel pays off, open, update, close, timeouts, backups | `references/payment-channels.md` |`.
- Phase-2 note (last paragraph): `Contracts, multi-party funding, adversarial review and 1Color references arrive in phase 2; the covenant form of a payment channel (construction C in `references/payment-channels.md`) and any two-wallet opening need them. Until then, …` (keep the rest).

**Commands:** `bsv-review.md` line 1 `G-01`..`G-38`; step 4 gains one sentence: `For any payment channel (states signed off-chain over one outpoint), also walk G-35 to G-38 from `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/payment-channels.md`.` `bsv-design.md` §2 item 5 gains: `When one money path has many updates between the same two parties, say whether it is a payment channel (`${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/payment-channels.md`) and name its open, update, close and timeout shapes.`

**Tests:**
- `references.test.ts` `must` map gains `'payment-channels.md': ['0xc3', '0xc2', '476', 'SEEN_ON_NETWORK', 'competingTxs', 'hashToDirectlySign', 'nLockTime', 'BRC-121', 'G-35', 'G-38', 'newest']`; the `sections` map gains `'payment-channels.md': ['When a channel is worth it', 'What works today', 'Three constructions', 'Open', 'Update', 'Close, cooperative', 'Close without the counterparty', 'Stale states and disputes', 'Backups', 'Rúnar for the covenant', 'Arcade for the open and the close', 'Review checklist']`; a new test `payment-channels.md never relies on replacement`: every line containing `replace` must match `/no |never|not |cannot|without/i`.
- `triggers.corpus.ts`: activate `open a payment channel between two BSV wallets`, `stream micropayments over a BSV payment channel`, `should I use a payment channel or BRC-29 payments for my BSV game`; ignore `set up a Lightning payment channel`, `open a Raiden state channel on Ethereum`.
- `structure.test.ts` needs no edit: it requires every reference to be routed and every routed file to exist.

**Steps:**

- [ ] **Step 1 (RED):** add the test entries and corpus rows; run `pnpm -F bsv-dev-skill test` and confirm the new cases fail (missing file, missing routing, description trigger).
- [ ] **Step 2 (GREEN):** write the reference from the outline; apply the SKILL.md, spec §6.1, and command edits; run the skill tests.
- [ ] **Step 3:** `pnpm build && pnpm test`, `pnpm sync:check`, `bash scripts/anti-goals.sh`, `npx -y skills-ref@0.1.5 validate packages/skill/skills/bsv-dev`. Commit:

```bash
git add packages/skill docs/superpowers/specs/2026-10-22-bsv-ai-devkit-design.md
git commit -m "feat(skill): payment-channels reference, routing, default decision and triggers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Cross-links in the threat model, custody shapes and the 402 sections

**Files:**
- Modify: `content/threat-model.md`, `content/custody-shapes.md`, `packages/skill/skills/bsv-dev/references/payments-brc29.md`
- Regenerate: `packages/mcp/content/**`, the skill's `threat-model.md` and `custody-shapes.md`

**Edits:**
- `threat-model.md`, new section `## Channel residuals` after "Ordinary failures to handle": four bullets: stale-state race (newest matures first, post at maturity, first-seen), median-time-past lag (an hour on seconds schedules; prefer heights), liveness bound (act within the window after a maturity point; no relative lock times), twin openings (follow the confirmed spender). End with "Details and the constructions: the `payment-channels` facts and the skill's `payment-channels.md`." Keep "failed payment" wording out of these lines (the fund-safety test checks that phrase only beside the two-read rule).
- `custody-shapes.md`, under "Both shapes may coexist": one paragraph: a payment channel is shape A at both ends (each party's wallet signs states silently under a level-1 protocol); an operator may fund and referee it (shape B, with the bounded budgets above), or only relay; see the `payment-channels` facts.
- `payments-brc29.md`, end of `## HTTP 402`: `One client paying one server many times in a session may be better served by a one-way payment channel; the trade-off and the construction are in `payment-channels.md`.`

**Steps:**

- [ ] **Step 1:** make the edits; `pnpm sync`; `pnpm check:facts`; `pnpm test`; `bash scripts/anti-goals.sh`; `pnpm sync:check`.
- [ ] **Step 2:** commit:

```bash
git add content packages/mcp/content packages/skill/skills/bsv-dev/references
git commit -m "docs(content): link the threat model, custody shapes and 402 guidance to payment channels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Final verification

- [ ] `pnpm install --frozen-lockfile && pnpm build && pnpm test`
- [ ] `pnpm sync:check`, `pnpm check:facts --max-age-days 60`, `bash scripts/anti-goals.sh`
- [ ] `pnpm check:links` (network: the wiki, the hub page and the two GitHub files must answer)
- [ ] `npx -y skills-ref@0.1.5 validate packages/skill/skills/bsv-dev`; `claude plugin validate --strict packages/skill` and `claude plugin validate --strict .` where the CLI is available
- [ ] Grep the diff for the earlier apps' names (listed in the private brief) and for local home-directory paths before the PR is updated: `git diff main --name-only | xargs grep -n -i -E "<names from the brief>|/Users/"` must print nothing.
- [ ] Update PR bsv-blockchain/bsv-mcp#11's description with one bullet: "Payment channels: facts, reference, G-35..G-38".

## Follow-ups (out of scope here)

- **WriteChoice docs:** `docs/writechoice/briefing.md` "Page-by-page changes" needs one line asking for a `guides/payment-channels` page (or a section under the payments guide) that states the verdict above and links the kit's reference; when it exists, add `guides.payment-channels` to `content/docs-index.yaml` and to the `refs` of `G-35`. The existing wiki page should be linked as background, not as current guidance for option 1.
- **Sample:** a `channel-one-way` or `escrow-runar` sample in phase 2 is the place to run construction A on testnet and turn its "not run by BSVA" mark into a measured row.
- **Phase 2 references:** `multi-party-funding.md` (co-funded openings), `runar-contracts.md` and `adversarial-review.md` are referenced from the channel reference by name; the routing row for construction C is complete only once they land.
- **`contract_review` (phase 2):** add the channel checks to its heuristics: a `checkSig` over an argument named like a state signature without an `extractSequence` read in the same method; a height gate without `< 500000000`.
- **SV Node non-final pool:** if the kit ever supports direct node submission, re-verify the pool's relay behaviour and defaults and revisit `G-35`.

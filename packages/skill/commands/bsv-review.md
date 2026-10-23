---
description: Review a BSV project against the guardrails
argument-hint: [path]
---

Review the BSV project at `$ARGUMENTS` against the bsv-dev guardrails `G-01`..`G-38`. Follow the bsv-dev skill (`${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/SKILL.md`) throughout; this is its Verify and Deliver steps.

1. **Resolve the path.** If `$ARGUMENTS` is empty, use the current project root. Resolve it to an ABSOLUTE path (for example with `realpath`) before anything else: `check_guardrails` rejects relative paths. Say which path you are reviewing.

2. **Automated check.** Call the `bsv-mcp` tool `check_guardrails` with that absolute path (`shape: "auto"` unless the user has stated the custody shape). Then:
   - Fix every finding with severity `error`, using the `fix` and `ref` each finding carries. Show the user each change.
   - List the warnings with your judgment on each; fix the ones that are real.
   - Re-run `check_guardrails` until it reports 0 errors.

   If the `bsv-mcp` server is not available, print the install command from `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/assets/install-commands.md` for the user to run, never edit their agent configuration yourself, and walk `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/guardrails.md` by hand instead.

3. **Manual checklist.** Walk every item of the `manualChecklist` that `check_guardrails` returned. For each id, read its guardrail from the `bsv://guardrails` resource (one guardrail at a time as `bsv://guardrails#G-xx`), check the project's code against it, and record pass, fail (with file and line) or not applicable (with the reason). Fix each fail or list it for the user.

4. **Contracts.** For every `*.runar.ts` file, do an adversarial pass: read `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/threat-model.md` (or `bsv://threat-model`), then try to break the contract as an attacker would: who can spend each output, under what conditions, with which transaction shapes, and what a counterparty gains by stalling, front-running or replaying. Check that real-crypto `Spend` tests exist for each path (G-28). Contract-specific review references arrive in phase 2; until then use the threat model and guardrails G-25 to G-30. For any payment channel (states signed off-chain over one outpoint), also walk G-35 to G-38 from `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/payment-channels.md`.

5. **Trust model (G-34).** Check that the app's docs carry a trust-model paragraph covering: served-code trust under the wallet's grouped grant; the 0-conf stance (final at `SEEN_ON_NETWORK` or later with no competing transaction; miner collusion not modelled); and what the server can and cannot do with users' money. If it is missing or incomplete, draft it from the threat model and show it to the user.

End with a summary: path reviewed, custody shape detected, errors fixed, warnings and their status, manual checklist results, contract findings, and the trust-model status.

Never ask for, print or generate a private key, WIF, seed or recovery phrase while reviewing, and never broadcast anything.

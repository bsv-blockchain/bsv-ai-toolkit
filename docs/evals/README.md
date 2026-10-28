# Evals

Evidence that the kit works for an agent that has never seen it. This folder holds the fresh-agent protocol, the starter app it runs against, the run template, the run records, and the [phase-1 exit checklist](phase-1-exit-checklist.md). The testnet gate (`pnpm -F bsv-tipping-demo gate run`, see [the sample's README](../../samples/tipping-shape-a/README.md#testnet-gate)) writes its records here too, as `gate-<time>.md`.

## Fresh-agent protocol

One run is one fresh Claude Code session building tipping into a plain React app, with only the skill and the docs MCP to guide it. Phase 1 needs three runs that pass. Run each in its own session and its own directory; never reuse a directory, a session or a transcript between runs.

### Setup, per run

1. Create a new, empty parent directory, and inside it the starter app exactly as [`starter-app.md`](starter-app.md) describes.
2. In the starter directory, install the skill and the docs MCP, and nothing else:

   ```bash
   npx skills add bsv-blockchain/bsv-ai-toolkit
   claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp
   ```

3. Check that `@bsv/mcp` is **not** installed for the session: `claude mcp list` shows `bsv-docs` and no `bsv-mcp`. Remove any user-level or project-level `bsv-mcp` entry before you start, and do not install the `bsv-dev` plugin, which bundles it. The run measures the skill and the docs on their own.
4. Note the agent version (`claude --version`) and the skill version (`metadata.version` in the installed `SKILL.md` frontmatter), and the create-vite version (`npm view create-vite version` on the day of the run).

### The session

1. Start a new Claude Code session in the starter directory.
2. Send this prompt, verbatim, as the first and only instruction:

   ```text
   add tipping to my React app on BSV
   ```

3. Do not steer. Answer the agent's questions, and only with the facts in [`starter-app.md`](starter-app.md#answers-to-the-agents-questions). Approve the commands it asks to run, unless a command would touch a real wallet, a key or mainnet; then refuse and record it in the notes. Give no hints, corrections or follow-up instructions.
4. The session ends when the agent says it is done. Do not ask it to fix anything afterwards.

### Scoring

After the session, from a clone of this repository with `pnpm build` done:

```bash
node <repo>/packages/mcp/build/cli/check-guardrails.js <starter>
```

`<repo>` is the clone, `<starter>` the starter directory. The command prints the report JSON on stdout and a summary on stderr, and exits 1 on any `error` finding. Record the number of `error` and `warn` findings and keep the JSON.

A run **passes** with zero `error` findings. Warnings are recorded but do not fail a run.

### Recording

Save each run as `docs/evals/2026-MM-DD-run-N.md` (the date of the run, `N` its number on that day), copied from [`TEMPLATE-run.md`](TEMPLATE-run.md): the prompt, the agent version, the skill version, the commands the agent ran, the guardrail report JSON, pass or fail, and notes.

Never paste a private key, WIF, seed phrase, wallet password or wallet details into a record. If the transcript shows one, leave it out and say so in the notes.

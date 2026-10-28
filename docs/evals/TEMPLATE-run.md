# Fresh-agent run 2026-MM-DD run N

Copy this file to `docs/evals/2026-MM-DD-run-N.md` and fill it in. See the [protocol](README.md). Never paste a private key, WIF, seed phrase, wallet password or wallet details.

## Run

| Field | Value |
| --- | --- |
| Date | 2026-MM-DD |
| Run | N |
| Prompt | `add tipping to my React app on BSV` |
| Agent version | `claude --version` output |
| Skill version | `metadata.version` from the installed `SKILL.md` |
| create-vite version | `npm view create-vite version` on the day of the run |
| MCP servers in the session | `claude mcp list` output (expected: `bsv-docs` only) |
| Result | PASS or FAIL |
| Findings | `error`: 0, `warn`: 0 |

## Questions the agent asked

Each question and the answer given, from [`starter-app.md`](starter-app.md#answers-to-the-agents-questions).

- Question: answer

## Commands the agent ran

In order, as the agent ran them.

```bash
```

## Guardrail report

`node <repo>/packages/mcp/build/cli/check-guardrails.js <starter>`, stdout:

```json
```

## Notes

What the agent got right or wrong, anything it tried to do with a wallet, a key or mainnet, and anything left out of this record and why.

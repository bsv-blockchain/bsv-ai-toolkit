# `@bsv/simple-mcp` deprecation

Prepared materials for retiring [`bsv-blockchain/simple-mcp`](https://github.com/bsv-blockchain/simple-mcp)
(`@bsv/simple-mcp` 0.0.2 on npm, bin `simple-mcp`). Its `@bsv/simple` reference and prompts now live in `@bsv/mcp` 2.x as the
resources `bsv://simple/api` and `bsv://simple/gotchas` and the prompts `integrate_simple`, `add_simple_feature` and
`debug_simple`. Version 0.0.3 is a stub that tells users to switch.

Nothing here is published from this repository. A person with write access to `bsv-blockchain/simple-mcp` opens the PR, and the
repository owner merges, publishes and archives.

| File | Goes to |
|---|---|
| `files/src/index.ts` | replaces `src/index.ts` |
| `files/package.json` | replaces `package.json` (0.0.2 with `version` `0.0.3` and `@modelcontextprotocol/sdk` `^1.32.1`; nothing else differs. It has no `deprecated` field: `npm publish` ignores one, and only `npm deprecate` (step 8) marks versions deprecated) |
| `files/README-banner.md` | prepended to `README.md` |
| `PR-body.md` | the PR description |

`packages/sync/test/deprecation.test.ts` checks that `files/src/index.ts` type-checks against the MCP SDK and prints the notice on
start.

## Steps

1. Get the owner's sign-off on `bsv-blockchain/simple-mcp` for deprecating the package and archiving the repository.
2. Fork the repository (or clone it, with write access) and create a branch, e.g. `deprecate-0.0.3`.
3. Copy the files in:
   ```bash
   KIT=/path/to/bsv-ai-toolkit/docs/deprecation/simple-mcp
   cp "$KIT/files/src/index.ts" src/index.ts
   cp "$KIT/files/package.json" package.json
   git rm -r src/resources src/tools src/prompts
   cat "$KIT/files/README-banner.md" README.md > README.new && mv README.new README.md
   ```
4. Refresh the lockfile and build: `npm install --package-lock-only && npm ci && npm run build`.
5. Work through the checklist in `PR-body.md`.
6. Commit, push, and open the PR against `main` with `PR-body.md` as the description.
7. The owner reviews and merges. The existing `push.yaml` publish job publishes 0.0.3 on the merge to `main`, because that
   version is not yet on npm. Check with `npm view @bsv/simple-mcp version`; if the job did not publish, the owner runs
   `npm publish` from the merged `main`.
8. The owner deprecates every version:
   ```bash
   npm deprecate @bsv/simple-mcp "Replaced by @bsv/mcp 2.x: npm i -g @bsv/mcp"
   ```
9. Once WriteChoice has updated `/docs/build-with-ai` to point at `@bsv/mcp`, the owner archives the repository
   (Settings, then Archive this repository).

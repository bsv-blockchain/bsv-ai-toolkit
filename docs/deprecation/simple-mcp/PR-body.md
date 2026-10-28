## Deprecate `@bsv/simple-mcp` in favour of `@bsv/mcp` 2.x

The `@bsv/simple` reference and prompts this server carried now ship in [`@bsv/mcp`](https://www.npmjs.com/package/@bsv/mcp) 2.x
([source](https://github.com/bsv-blockchain/bsv-ai-toolkit)), alongside the rest of the BSV dev kit. This PR turns `@bsv/simple-mcp` into a
stub that points users there, as version 0.0.3.

### What changes

- `src/index.ts` is replaced by a small server that reports itself as `@bsv/simple-mcp` 0.0.3. On start it prints
  `@bsv/simple-mcp is deprecated. Install @bsv/mcp: claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp` to stderr,
  then serves over stdio as before, so existing MCP clients still connect. It registers one resource, `simple://deprecated`
  (Markdown: how to install `@bsv/mcp` and where each piece moved), and no tools or prompts.
- `src/resources/`, `src/tools/` and `src/prompts/` are removed.
- `package.json`: `version` `0.0.3` and `@modelcontextprotocol/sdk` raised from
  `^1.11.0` to `^1.32.1`, because the stub uses `registerResource` with a `title`, which `^1.11` does not guarantee. Nothing else
  changes. `package-lock.json` is refreshed to match.
- `README.md` gains a deprecation banner with the install command and a table of where each resource and prompt moved:

| `@bsv/simple-mcp` 0.0.2 | `@bsv/mcp` 2.x |
|---|---|
| `simple://api/*`, `simple://guide/nextjs`, `simple://guide/patterns` | resource `bsv://simple/api` |
| `simple://guide/gotchas` | resource `bsv://simple/gotchas` |
| prompt `integrate_simple` | prompt `integrate_simple` |
| prompt `add_bsv_feature` | prompt `add_simple_feature` |
| prompt `debug_simple` | prompt `debug_simple` |
| `scaffold_nextjs_config` and the `generate_*` tools | none: the prompts guide the agent to write the code, testnet first |

### Release

Merging to `main` runs the existing `push.yaml` publish job, which publishes 0.0.3 because that version is not yet on npm.
Once 0.0.3 is on npm, the owner marks every version deprecated:

```bash
npm deprecate @bsv/simple-mcp "Replaced by @bsv/mcp 2.x: npm i -g @bsv/mcp"
```

### Archive

Archive this repository after the docs page is updated: the "Set up your AI" page (`/docs/build-with-ai`) must point at
`@bsv/mcp` first, so nobody following the docs lands on an archived repo.

### Checklist (run in this checkout before requesting review)

- [ ] `npm install --package-lock-only` refreshed `package-lock.json`, and `npm ci` passes.
- [ ] `npm run build` passes with the repository's own `tsconfig.json`.
- [ ] `node dist/index.js < /dev/null` prints the deprecation notice to stderr and exits 0.
- [ ] Over stdio, `initialize` reports `@bsv/simple-mcp` 0.0.3 and `resources/list` returns exactly one resource,
  `simple://deprecated`, with no tools.
- [ ] `npx -y @bsv/mcp` starts the replacement server (stop it with Ctrl-C).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

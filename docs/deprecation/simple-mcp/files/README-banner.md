> [!WARNING]
> **`@bsv/simple-mcp` is deprecated and no longer maintained.** Its `@bsv/simple` reference and
> prompts now ship in [`@bsv/mcp`](https://www.npmjs.com/package/@bsv/mcp) 2.x
> ([source](https://github.com/bsv-blockchain/bsv-ai-toolkit)). Install it, testnet first:
>
> ```bash
> claude mcp remove simple-mcp
> claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp
> ```
>
> | `@bsv/simple-mcp` 0.0.2 | `@bsv/mcp` 2.x |
> |---|---|
> | `simple://api/*`, `simple://guide/nextjs`, `simple://guide/patterns` | resource `bsv://simple/api` |
> | `simple://guide/gotchas` | resource `bsv://simple/gotchas` |
> | prompt `integrate_simple` | prompt `integrate_simple` |
> | prompt `add_bsv_feature` | prompt `add_simple_feature` |
> | prompt `debug_simple` | prompt `debug_simple` |
> | `scaffold_nextjs_config` and the `generate_*` tools | none: the prompts guide your agent to write the code, testnet first |
>
> Version 0.0.3 is a stub: it prints this notice on start and serves one resource, `simple://deprecated`, with no tools.
> The documentation below describes 0.0.2 and is kept for reference only.


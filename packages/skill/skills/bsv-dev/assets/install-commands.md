# Install commands

The bsv-dev skill and its two MCP servers: `bsv-docs` (the BSV documentation) and `bsv-mcp` (`@bsv/mcp`, testnet by default). Print these for the user to run; never run them for the user and never edit an agent configuration. `install.sh` prints the same lines.

## Any agent that reads Agent Skills

```bash
npx skills add bsv-blockchain/bsv-ai-toolkit
```

## Claude Code: plugin (skill plus both MCP servers)

```bash
claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv
```

## Claude Code: MCP servers only

```bash
claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp
claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp
```

## Codex

```bash
codex mcp add bsv-docs --url https://bsv.writedocs.io/mcp  # verify against codex --help
codex mcp add bsv-mcp --env BSV_NETWORK=testnet -- npx -y @bsv/mcp  # verify against codex --help
```

## Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bsv-mcp": {
      "command": "npx",
      "args": ["-y", "@bsv/mcp"],
      "env": { "BSV_NETWORK": "testnet" }
    },
    "bsv-docs": {
      "url": "https://bsv.writedocs.io/mcp"
    }
  }
}
```

## Windsurf

Add to Windsurf's MCP configuration. Windsurf names the URL field `"serverUrl"`:

```json
{
  "mcpServers": {
    "bsv-mcp": {
      "command": "npx",
      "args": ["-y", "@bsv/mcp"],
      "env": { "BSV_NETWORK": "testnet" }
    },
    "bsv-docs": {
      "serverUrl": "https://bsv.writedocs.io/mcp"
    }
  }
}
```

## VS Code

Add to `.vscode/mcp.json`. VS Code uses a top-level `"servers"` key instead of `"mcpServers"`:

```json
{
  "servers": {
    "bsv-mcp": {
      "command": "npx",
      "args": ["-y", "@bsv/mcp"],
      "env": { "BSV_NETWORK": "testnet" }
    },
    "bsv-docs": {
      "type": "http",
      "url": "https://bsv.writedocs.io/mcp"
    }
  }
}
```

Keep `BSV_NETWORK=testnet` until the app is ready for mainnet; see `references/testnet-to-mainnet.md`.

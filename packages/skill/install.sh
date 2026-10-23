#!/usr/bin/env bash
# Prints the commands that install the bsv-dev skill and its two MCP servers.
# It only prints: it runs nothing, writes no file and never edits any agent configuration.
# Copy the lines for your agent and run them yourself.
set -euo pipefail

cat <<'TEXT'
# bsv-dev skill: install commands (printed only; nothing was changed)

## Any agent that reads Agent Skills
npx skills add bsv-blockchain/bsv-ai-toolkit

## Claude Code: plugin (skill plus both MCP servers)
claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv

## Claude Code: MCP servers only
claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp
claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp

## Codex
codex mcp add bsv-docs --url https://bsv.writedocs.io/mcp  # verify against codex --help
codex mcp add bsv-mcp --env BSV_NETWORK=testnet -- npx -y @bsv/mcp  # verify against codex --help

## Cursor, Windsurf, VS Code: add to the client's MCP JSON configuration
## (Cursor: .cursor/mcp.json; Windsurf names the URL field "serverUrl";
##  VS Code: .vscode/mcp.json uses a top-level "servers" key instead of "mcpServers")
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
TEXT

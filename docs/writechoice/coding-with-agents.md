---
title: Coding with agents
description: Set up your AI coding agent to build on BSV with the BSV docs MCP, the bsv-dev skill and @bsv/mcp, testnet first.
---

Set up an AI coding agent, such as Claude Code, Codex, Cursor, Windsurf or VS Code, so it builds BSV apps the way these docs describe. Three pieces, each one command: the docs MCP gives the agent these pages, the `bsv-dev` skill gives it judgment, and `@bsv/mcp` gives it live tools.

> **Draft.** The docs MCP works today. The skill and `@bsv/mcp` 2.0.0 are available once `@bsv/mcp` v2.0.0 and `bsv-dev` 0.1.0 are released; until then, `npx @bsv/mcp` installs the older 1.x server, which this page does not describe.

## Why agents and BSV

- **Testnet-safe by default.** Every command on this page starts on testnet, where coins are free from the faucet at [bsvfaucet.com](https://bsvfaucet.com). Mainnet is real money, and you reach it only by setting `BSV_NETWORK=mainnet` yourself.
- **Wallet approvals in BSV Desktop.** The agent writes apps that ask the user's BRC-100 wallet, such as BSV Desktop, to sign. A person decides in the wallet what an app may spend; the agent cannot approve anything for them.
- **No keys in code.** The wallet holds the keys. The agent never asks for, prints or stores a private key or a recovery phrase, and the code it writes holds none.

## 1. Add the docs MCP

The docs MCP server lets the agent list, search and read these pages (`list_docs`, `search_docs`, `get_doc`). Install it as `bsv-docs`.

Claude Code:

```bash
claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp
```

Codex (verify the flags against `codex --help`):

```bash
codex mcp add bsv-docs --url https://bsv.writedocs.io/mcp  # verify against codex --help
```

Cursor, Windsurf and VS Code take JSON. Each block below adds the docs MCP and `@bsv/mcp` from [step 3](#3-add-bsvmcp-for-live-tools); remove the `bsv-mcp` entry if you want only the docs.

Cursor, in `.cursor/mcp.json`:

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

Windsurf, in its MCP configuration. Windsurf names the URL field `"serverUrl"`:

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

VS Code, in `.vscode/mcp.json`. VS Code uses a top-level `"servers"` key instead of `"mcpServers"`:

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

An agent without MCP support can read the docs as Markdown, starting from [llms.txt](https://bsv.writedocs.io/llms.txt).

## 2. Install the BSV skill

The `bsv-dev` skill is a playbook the agent loads when it works on BSV: choosing who holds the keys (the user's wallet, or a server wallet), connecting a BRC-100 wallet, BRC-29 payments, broadcasting through Arcade and when a payment is final, taking an app from testnet to mainnet, and checking the result against the BSV guardrails.

Any agent that reads Agent Skills:

```bash
npx skills add bsv-blockchain/bsv-ai-toolkit
```

Claude Code, as a plugin:

```bash
claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv
```

The plugin bundles both MCP servers, `bsv-docs` and `bsv-mcp`, so in Claude Code it replaces steps 1 and 3. It asks for two settings, the network (default `testnet`) and an optional Arcade URL, and adds the commands `/bsv-review [path]` and `/bsv-design [app name]`. It needs Claude Code v2.1.271 or later.

The skill never edits your agent configuration. When an MCP server is missing, it prints the install command for you to run.

## 3. Add @bsv/mcp for live tools

`@bsv/mcp` gives the agent tools that act and read live data, on testnet unless you configure mainnet. Install it as `bsv-mcp`. It needs Node 22 or later.

Claude Code:

```bash
claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp
```

Codex (verify the flags against `codex --help`):

```bash
codex mcp add bsv-mcp --env BSV_NETWORK=testnet -- npx -y @bsv/mcp  # verify against codex --help
```

For Cursor, Windsurf and VS Code, use the JSON in [step 1](#1-add-the-docs-mcp).

What the tools do:

| Tool | What it does |
| --- | --- |
| `arcade_submit` | Broadcasts a signed transaction to Arcade and reads its status back |
| `arcade_status` | Reads a transaction's status from Arcade and says whether it is final for an app: `SEEN_ON_NETWORK` or later with no competing transaction |
| `arcade_policy`, `arcade_health` | Read Arcade's fee policy and health |
| `check_guardrails` | Checks a project against the BSV guardrails and lists each finding with its fix; it reads the project and changes nothing |
| `brc_lookup` | Returns a BRC standard as Markdown |
| `versions_check` | Compares the recommended library versions with the latest releases |
| `docs_url` | Finds the live page for a docs id |
| `code_search`, `find_function_definition` | Search local copies of the BSV repositories, after you run `setup.sh` from the [repository](https://github.com/bsv-blockchain/bsv-ai-toolkit) and set `BSV_REPOS_DIR` |

It also serves dated facts (networks, Arcade, fees, wallet limits), the guardrails and the `@bsv/simple` reference as resources, so the agent reads current values instead of guessing.

## Example prompts

Try these once the pieces are installed. [Send a payment with an AI agent](/docs/build-with-ai/prompts) walks through a first payment step by step.

- "Add tipping to my React app on BSV. Use BSV Desktop on testnet."
- "Check transaction `<txid>` on Arcade and tell me whether it is final."
- "Review my app against the BSV guardrails and fix every error." In Claude Code with the plugin, `/bsv-review` does the same.

## What goes where

| Piece | Gives the agent | For example |
| --- | --- | --- |
| Docs (`bsv-docs`) | Prose: how BSV and its tools work | Guides, tutorials, API reference |
| Skill (`bsv-dev`) | Judgment: what to build and how to check it | Which wallet shape fits, what to verify before mainnet |
| MCP (`bsv-mcp`) | Actions and live data | Broadcast, read a status, check a project, current versions and facts |

## Safety

- **Testnet.** Everything here defaults to testnet. An app built this way switches networks with one `BSV_NETWORK` variable, read by both its server and its client, and refuses to pay when the user's wallet is on a different network.
- **Approvals.** A person approves in BSV Desktop what an app may spend. An app asks once for a grouped permission with a small monthly allowance, and the wallet prompts for anything above it.
- **No keys.** No tool in `@bsv/mcp` takes, stores or signs with a private key: `arcade_submit` broadcasts transactions that are already signed. The skill never asks for a key, and `check_guardrails` flags a key in client code.
- **Mainnet broadcasts by the agent.** Any mainnet broadcast by `arcade_submit`, whether from `BSV_NETWORK=mainnet` or a per-call `network: 'mainnet'`, needs `BSV_MCP_ALLOW_MAINNET_BROADCAST=1`, or the tool refuses before contacting Arcade. This switch is for the agent only: it controls whether the agent's own `arcade_submit` tool may broadcast real money, and apps never read it. Set it yourself, in the shell that starts the agent, and only when you mean it. The agent never sets it itself, and the plugin never sets it.
- **Commands.** Claude Code asks before the agent runs a command such as `npm install`. Read each one before you allow it.

## Skills library

**Official.** `bsv-dev`, maintained by the BSV Association in [bsv-blockchain/bsv-ai-toolkit](https://github.com/bsv-blockchain/bsv-ai-toolkit).

**Community.** Skills from other authors are listed in [`community-skills.yaml`](https://github.com/bsv-blockchain/bsv-ai-toolkit/blob/main/community-skills.yaml) (the link resolves once this work merges to `main`). The list is empty for now.

To submit a skill, open a pull request on `bsv-blockchain/bsv-ai-toolkit` that adds one entry to `community-skills.yaml`, with `name`, `repo`, `commit`, `description` and `maintainer`. `commit` is the full commit SHA that was reviewed, and every link in the entry points at that commit, so readers install what was reviewed. A new version is a new pull request with a new commit.

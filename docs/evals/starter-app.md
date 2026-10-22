# Starter app

The app every fresh-agent run starts from: a plain Vite React TypeScript app with `@bsv/sdk` and nothing else from BSV. Create it new for each run, in a new empty parent directory.

```bash
mkdir <new empty directory> && cd <new empty directory>
npm create vite@latest starter -- --template react-ts
cd starter
npm install
npm i @bsv/sdk@3.2.1
```

Then follow the setup in the [protocol](README.md#setup-per-run) from inside `starter/`. Do not add files, rules (`CLAUDE.md`, `AGENTS.md`) or a git history beyond what these commands create.

## Answers to the agent's questions

These are the only facts you give the agent, and only when it asks.

| If the agent asks about | Answer |
| --- | --- |
| The network | Testnet. |
| The creator who receives the tips, or their identity key | The creator's identity key is not known yet. Use a placeholder that the creator fills in later, read from configuration, for example `<creator identity public key>`. |

For any other question, answer "use your recommended default". Never give a private key, a WIF, a seed phrase or wallet details, and never agree to mainnet.

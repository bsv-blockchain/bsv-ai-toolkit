# Briefing for WriteChoice: the BSV AI DevKit

From the BSV Association, for the WriteChoice docs team. This is the repository's copy of the briefing sent on 2026-10-22, brought up to date with what the `bsv-blockchain/bsv-ai-toolkit` repository now contains. Where the two differ, this copy is current; [Since the first briefing](#since-the-first-briefing) lists the differences.

Nothing in this kit is released yet. Every install command below works once `@bsv/mcp` 2.0.0 and the `bsv-dev` skill 0.1.0 are released; until then `npx @bsv/mcp` resolves the older 1.x package. Host facts were checked on 2026-10-22.

The draft page for `/docs/build-with-ai` is [`coding-with-agents.md`](coding-with-agents.md), next to this file.

## What this project ships and owns

Six pieces, one job each:

| Piece | Owner | Job | Not its job |
| --- | --- | --- | --- |
| Docs site, including the new Coding with agents page at `/docs/build-with-ai` | WriteChoice | Canonical prose; an agent set up in three commands or fewer | Judgment; live chain data |
| Docs MCP (`https://bsv.writedocs.io/mcp`, later the final host) | WriteChoice | `list_docs`, `search_docs`, `get_doc` | Running code or touching the chain |
| `llms.txt`, `llms-full.txt` and the `.md` page variants | WriteChoice | Agent-readable docs | |
| `@bsv/mcp` 2.0.0 on npm, absorbing `@bsv/simple-mcp` | BSVA, `bsv-blockchain/bsv-ai-toolkit` | Actions and live data | Teaching; long prose |
| `bsv-dev` skill 0.1.0 (package `bsv-dev-skill`), also a Claude Code plugin | BSVA, same repository | Judgment and workflow | Facts that change weekly |
| Sample apps | BSVA, same repository | Runnable reference apps mapped to the guardrails | Tutorials |

Short version: the docs MCP answers questions about the docs, the skill tells an agent how to build on BSV well, and `@bsv/mcp` does things.

What the repository holds today:

- **`content/`, the single source.** Dated facts (`facts/*.md`, each with `verified: YYYY-MM-DD`), the guardrails `G-01` to `G-38` (`guardrails.yaml`), pinned versions (`versions.json`), the docs index (`docs-index.yaml`), custody shapes and the threat model. A build step (`packages/sync`) renders it into the MCP package and the skill, and CI fails when the generated copies drift. The kit never copies docs prose: it links to your pages by id (see [Host move request](#host-move-request)).
- **`@bsv/mcp` 2.0.0** (`packages/mcp`), testnet by default. Tools: `arcade_submit`, `arcade_status`, `arcade_policy`, `arcade_health`, `check_guardrails` (a read-only static check of a project against the guardrails), `brc_lookup`, `versions_check`, `docs_url`, `code_search`, `find_function_definition`. Resources: `bsv://facts/*`, `bsv://guardrails`, `bsv://custody-shapes`, `bsv://threat-model`, `bsv://docs/index`, `bsv://simple/api`, `bsv://simple/gotchas`, `bsv://brc/{id}`. The `@bsv/simple` prompts from `@bsv/simple-mcp` are folded in and rewritten for `@bsv/simple` 0.7. The deprecation release of `@bsv/simple-mcp` (a 0.0.3 that points at `@bsv/mcp`) is prepared for that repository's owner to publish.
- **The `bsv-dev` skill 0.1.0** (`packages/skill`). `SKILL.md` plus references on custody shapes, BRC-100 wallets, BRC-29 payments, Arcade and 0-conf, when `@bsv/simple` fits, testnet to mainnet, the threat model and common errors; assets (a `manifest.json` template, `env.example`, project-rule snippets for `CLAUDE.md`, `AGENTS.md` and Cursor); the commands `/bsv-review` and `/bsv-design`. As a Claude Code plugin it bundles both MCP servers: `bsv-mcp` (pinned to `@bsv/mcp@2.0.0`) and `bsv-docs` (your docs MCP). It asks for the network (default `testnet`) and an optional Arcade URL.
- **Samples** (`samples/`): `tipping-shape-a`, see [Samples for /docs/showcase](#samples-for-docsshowcase).

WriteChoice owns the site, `llms.txt` and the docs MCP. This kit owns the facts, the guardrails, the skill, `@bsv/mcp` and the samples.

### Decisions already made

- One BSV MCP for builders: `@bsv/simple-mcp` folds into `@bsv/mcp` and is deprecated. The docs MCP stays separate.
- BSVA hosts the skill in `bsv-blockchain/bsv-ai-toolkit` (the answer to docs question Q28).
- Names: the skill is `bsv-dev`; the Claude Code plugin is `bsv-dev` from the marketplace `bsv`. The two MCP servers install as `bsv-docs` and `bsv-mcp`.
- Where the wallet lives is the app's choice: a user-side BRC-100 wallet (shape A) or an app-side BRC-100 server wallet with `wallet-toolbox` or `go-wallet-toolbox` (shape B). Pages present both, with their trade-offs.
- Testnet first; mainnet is one switch away (`BSV_NETWORK`). Testnet coins come from `https://bsvfaucet.com`.
- Arcade for every broadcast and every transaction-status check, on the public endpoints or a self-run instance.
- Rúnar for all contracts; 1Color for all tokens.

## The three install commands

Available once `@bsv/mcp` 2.0.0 and `bsv-dev` 0.1.0 are released. Please use these exact strings on the site.

1. The skill, for any agent that reads Agent Skills:

   ```bash
   npx skills add bsv-blockchain/bsv-ai-toolkit
   ```

2. The Claude Code plugin (the skill plus both MCP servers):

   ```bash
   claude plugin marketplace add bsv-blockchain/bsv-ai-toolkit && claude plugin install bsv-dev@bsv
   ```

3. The two MCP servers on their own, in Claude Code:

   ```bash
   claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp
   claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp
   ```

The install names stay `bsv-docs` and `bsv-mcp` everywhere: the skill's rules and prompts refer to the tools by those names. Codex, Cursor, Windsurf and VS Code configuration is in [`coding-with-agents.md`](coding-with-agents.md), copied from the skill's `assets/install-commands.md`.

## Host move request

What we see today (checked 2026-10-22):

- `https://bsv.writedocs.io/mcp` is live. `https://docs.bsvblockchain.org/mcp` answers 404, and the "Copy MCP URL" button on `/docs/build-with-ai` points there. Please fix that URL now.
- `bsv.writedocs.io` serves guide pages as Markdown at `/docs/<path>.md`. The API reference pages (`/reference/arc/*`, `/reference/wallet-api/*`) are served without `/docs/`; `reference/networks` is a guide-site page under `/docs/`.
- `docs.bsvblockchain.org` answers `/docs/<path>.md` with HTTP 200 and a "Page Not Found" body, and the HTML `/docs/<path>` with 404. The legacy GitBook pages at other paths there (for example `/guides/...`) still serve.

How the kit links to you: every docs link goes through an id in `content/docs-index.yaml` (for example `guides.payments`, path `guides/payments`). The `docs_url` tool tries the hosts in order (`https://bsv.writedocs.io/docs/`, then `https://docs.bsvblockchain.org/docs/`), then the id's legacy URL when it has one, and takes the first that answers with a real page; a "Page Not Found" body counts as a miss. So when the pages move, links keep working as long as paths stay stable, and we change one file.

What we ask:

1. **The final URL** for the pages and for the docs MCP, and the date they move.
2. **A redirect map** from every old path to its new one, including `bsvblockchain.org/docs/*`, which goes to the old GitBook today.
3. **Stable paths** for the pages the kit links to (the ids in `content/docs-index.yaml`), or notice before one changes.
4. **A real 404** for a missing page. The HTTP 200 "Page Not Found" answer makes every tool that checks links do extra work.

## Samples for /docs/showcase

**`tipping-shape-a` (bsv-tipping-demo).** A one-page tipping app on custody shape A: the user's BRC-100 wallet holds every key. It connects BSV Desktop, checks the wallet's network, asks for one grouped permission through `manifest.json`, pays a creator with a BRC-29 payment, and the creator's page collects the tip at `SEEN_ON_NETWORK` with no competing transaction, through `internalizeAction`. A small relay passes each tip to Arcade and holds no key.

| | |
| --- | --- |
| Live demo | `https://tipping.bsvb.tech` `TODO(hosting)`: placeholder; the hosting team has not deployed it yet, and we will send the real origin |
| Source | `https://github.com/bsv-blockchain/bsv-ai-toolkit/tree/main/samples/tipping-shape-a` (resolves once this work merges to `main`) |
| Image | `ghcr.io/bsv-blockchain/bsv-tipping-demo` (published from `main` once this work merges) |
| Network | testnet |
| Checks | `check_guardrails` reports zero errors in CI; a testnet gate runs a real tip end to end; `GUARDRAILS.md` maps each guardrail to the file that meets it; `TRUST.md` states the trust model |
| Docs pages it builds on | `get-started.quick-start-browser`, `guides.payments`, `guides.wallet-aware-apps`, `guides.services.broadcasting` |

Later samples, listed, not built yet:

- `pay-per-call-shape-b`: BRC-121 payments through `@bsv/402-pay` with a server wallet (shape B); a `go-wallet-toolbox` variant after.
- `escrow-runar`: two-wallet funding with a timeout refund, built on Rúnar.
- `loyalty-1color`: 1Color tokens, once BRC-207 is in the official `wallet-toolbox`.
- `crowdfund-runar`: a deadline covenant (BRC-215), lowest priority.

## Stubs this kit depends on

The skill and the sample link to these pages. State on `bsv.writedocs.io` on 2026-10-22:

| Page | Today | What the kit needs from it |
| --- | --- | --- |
| `get-started/quick-start-server` | Scaffold placeholder | A testnet payment from a server wallet (shape B) with `wallet-toolbox`, Arcade configured explicitly |
| `guides/services/broadcasting` | Drafted | Already close. Two asks: final for an app is `SEEN_ON_NETWORK` with no `competingTxs`, so "follow the status until `SEEN_ON_NETWORK` or `MINED`" should stop at the first; and say which testnet host is official (the draft uses `arcade-v2-testnet-us-1`, the kit defaults to `arcade-testnet-us-1`; both are live) |
| `guides/go-to-mainnet` | Drafted | The one `BSV_NETWORK` switch, the wallet's network check, fees: configure 100 sat/kB on both networks from the start (testnet's 1 sat/kB minimum is refused on mainnet) |
| `reference/networks` | Scaffold placeholder | One row per network: Arcade endpoints, WhatsOnChain base, explorer, faucet, what `getNetwork()` returns. `content/facts/networks.md` has the table, dated |
| `wallets/bsv-desktop` | Scaffold placeholder | Versions, networks, the local ports (HTTP 3321, HTTPS 2121) and that a local BSV Desktop is often on mainnet. BSVA can draft it |
| `sdk/defaults` | Scaffold placeholder | Fee, network and storage defaults. Not yet in `docs-index.yaml`; the id is added when the page has content |
| `build-with-ai/skill` | Scaffold placeholder; its `.md` on `docs.bsvblockchain.org` is a "Page Not Found" body behind HTTP 200 | What the skill covers, install per agent, how it works with the two MCP servers. [`coding-with-agents.md`](coding-with-agents.md) has the install part |
| `guides/services/local-stack` | Scaffold placeholder | A local test chain for development and CI |

A scaffold placeholder answers HTTP 200 with real content, so `docs_url` resolves it as a live page: an agent following a kit link lands on the placeholder until the page is filled. BSVA can draft `guides/go-to-mainnet` and `wallets/bsv-desktop` if that helps.

## Docs samples that violate the guardrails

Each of these teaches a pattern the guardrails forbid, so an agent that learns from them writes code that `check_guardrails` then flags. The ids are the kit's guardrails (`bsv://guardrails#G-xx`).

| Page | Problem | Guardrail | Ask |
| --- | --- | --- | --- |
| Custom transaction broadcaster example, `https://docs.bsvblockchain.org/guides/sdks/ts/examples/example_building_custom_tx_broadcaster` | Posts raw hex to WhatsOnChain `/tx/raw` and swallows errors in an empty `catch` | G-09 (broadcast only through Arcade), G-12 (WhatsOnChain is never the truth for a known txid) | Rewrite as an Arcade broadcaster: `POST /tx`, then read `GET /tx/{txid}` |
| Event tickets use case, `https://docs.bsvblockchain.org/guides/business-use-cases/event_tickets` | Makes keys with `PrivateKey.fromRandom` in app code; the "tickets" are unfunded, unsigned P2PKH outputs | G-06 (no private keys in client code) | Retire it, or rewrite it on 1Color tokens with the user's wallet holding the keys |
| The `/reference/arc/*` block (linked from `llms.txt`) | Presents the legacy ARC API and its `/v1/tx` routes as current; apps must not use it | G-09 (broadcast only through Arcade) | Mark it legacy, never for new apps, and link the Arcade pages |
| Go and Python broadcasting examples | Not checked; likely the legacy ARC API, which G-09 says never to use | G-09 | Check them against G-09 |

Arcade's own docs have two gaps an agent trips on: no testnet endpoint is listed (`https://arcade-testnet-us-1.bsvblockchain.tech` is live, and `wallet-toolbox` also knows the `arcade-v2-*` hosts; please say which are official), and the `GET /tx/{txid}` fields (the spec says `rawTx` appears only in `PENDING_RETRY`, but it is returned on mined transactions too; an absent or empty `competingTxs` means no competitor).

## Replace the six-rule CLAUDE.md block on /llm-resources

`/docs/build-with-ai/llm-resources` has a six-rule `CLAUDE.md` block today. Keep the page as the fallback for agents without the skill, but replace the block with the skill's `assets/CLAUDE.md.snippet`, in full. It states the same principles as the rest of the docs, names the two MCP servers, and ends with the guardrail check. Keep the begin and end comment lines: they let a user or a tool find the block and update it. The skill ships the same rules as `assets/AGENTS.md.snippet` and, for Cursor, `assets/bsv.mdc`.

```markdown
<!-- bsv-dev rules: begin -->
1. Read https://bsv.writedocs.io/llms.txt first, then fetch only the pages the task needs. Its page links point at docs.bsvblockchain.org; open the same path on bsv.writedocs.io instead.
2. When the `bsv-docs` and `bsv-mcp` MCP servers are connected, use their tools before relying on memory for BSV APIs, versions, limits or fees.
3. Work on testnet unless `BSV_NETWORK=mainnet` is set on purpose by the operator. Before a payment, check that `wallet.getNetwork()` returns `testnet`.
4. For the user's wallet, connect with `@bsv/sdk` 3.x `new WalletClient('auto', originator)`, from the browser or a local script.
5. Never hold, ask for, print or generate for production use a private key, WIF or recovery phrase; the user's wallet (shape A) or an operator-set variable outside the repo (shape B) holds it.
6. Testnet coins come from https://bsvfaucet.com and wallet approvals come from the user: ask the user for both, and never work around either.
7. Use Arcade for every broadcast and every txid state read; never the legacy ARC API, and never WhatsOnChain as the truth for a known txid.
8. A transaction is final at `SEEN_ON_NETWORK` or later with no competing transaction; never wait for confirmations or `MINED`.
9. If `bsv-mcp` is connected, run `check_guardrails` with the project's absolute path and fix every error before calling the work done.
<!-- bsv-dev rules: end -->
```

Below the block, point at the skill (`build-with-ai/skill`), and replace the "Connect your AI tool with MCP" link (the `@bsv/simple-mcp` page) with the `@bsv/mcp` page.

## Principles every page should state the same way

| Topic | Say | Avoid |
| --- | --- | --- |
| Keys | The wallet holds the keys; the app asks it | Raw keys in app code |
| Login | `WalletClient('auto', originator)`, then `waitForAuthentication()`, `getPublicKey({ identityKey: true })`, and a `getNetwork()` match | `isAuthenticated()` as a gate (it throws on a locked wallet in `@bsv/sdk` 3.2.1) |
| Permissions | A BRC-73 `manifest.json` with grouped permissions under both the `metanet` and `babbage` keys | No manifest |
| Broadcasting | Arcade `POST /tx` with raw or EF hex | The SDK ARC class, the legacy `/v1/tx` routes, posting BEEF to Arcade, or broadcasting via WhatsOnChain: never |
| Transaction state | Arcade `GET /tx/{txid}` is the source of truth; a 200 on submit is not acceptance | WhatsOnChain as the truth: it lags 6 to 12 s and 404s fresh transactions |
| Finality | 0-conf is safe at `SEEN_ON_NETWORK` or later with no `competingTxs` | Waiting for `MINED`, "wait for 1 confirmation", machinery against miner collusion |
| WhatsOnChain | Only UTXO listings, spent-by and tip height, throttled | On the hot path; unthrottled browser calls |
| Fees | Configure 100 sat/kB on both networks, so testnet sizes and costs carry over; never below what `GET /policy` reports | Paying testnet's 1 sat/kB minimum, which mainnet refuses (code 465, fee too low) |
| Receiving payments | BRC-29 plus `internalizeAction` with complete AtomicBEEF | Partial BEEF |
| Networks | Testnet by default, coins from `bsvfaucet.com`, testnet Arcade `https://arcade-testnet-us-1.bsvblockchain.tech` | Mainnet in getting-started code |
| Contracts | Rúnar from upstream main (1.0.0-rc.1), tested with `Spend` | npm 0.4.6 (forgeable `checkPreimage`); `TestContract`, which mocks `checkSig` |
| Tokens | 1Color: BRC-162 format, BRC-207 wallet module, encoding in `@bsv/templates` 2.0 | "Mandala" (BRC-92 was withdrawn on 2 Oct 2026); claiming wallet support in the official `wallet-toolbox` or BSV Desktop before it ships |

## Page-by-page changes

| Page | Today | Change | When |
| --- | --- | --- | --- |
| `/docs/build-with-ai` | "Coming soon"; Copy MCP URL points at `docs.bsvblockchain.org/mcp` (404) | Becomes Coding with agents ([draft](coding-with-agents.md)); fix the MCP URL now | URL now; page at launch |
| `/docs/build-with-ai/simple-mcp` | Documents `@bsv/simple-mcp` | Replace with an `@bsv/mcp` page; one line saying `@bsv/simple-mcp` is deprecated and folded in | At launch |
| `/docs/build-with-ai/skill` | Empty scaffold | Coverage, install per agent, how it works with the two MCP servers | At launch |
| `/docs/build-with-ai/llm-resources` | Six `CLAUDE.md` rules | Keep as fallback; [replace the block](#replace-the-six-rule-claudemd-block-on-llm-resources); point at the skill | Now |
| `/docs/build-with-ai/prompts` | The agent sends a testnet payment | Add receiving: BRC-29 plus `internalizeAction` | Now |
| `/docs/get-started/quick-start-browser` | `WalletClient('auto')` and a 1,000-sat payment, checked on WhatsOnChain | Add `waitForAuthentication`, the `getNetwork` check and the manifest; check the payment on Arcade | Now |
| Quick start verify step | "unconfirmed to confirmed" | `SEEN_ON_NETWORK` with no competitor is final | Now |
| `/docs/get-started/project-starter` | `create-bsv-app` on `@bsv/sdk` 2.x | Flag as pending (a ts-stack request) | Later |
| `/docs/guides/payments` | 402 payments via `@bsv/402-pay` (BRC-121) with a server wallet | Label it as the app-side wallet shape; add Arcade status handling | Now |
| Stubs | Empty | See [Stubs this kit depends on](#stubs-this-kit-depends-on) | Now |
| New: choosing where the wallet lives | | Shape A against shape B, with trade-offs | Now |
| New: Rúnar contracts | | | At launch |
| New: 1Color tokens | | | At launch |

## Status and phases

1. **Phase 1, built in the repository, not yet released**: `@bsv/mcp` 2.0.0, `bsv-dev` 0.1.0 and the tipping sample, with CI, a nightly freshness check and a tag-only release with npm trusted publishing. For the docs: the Coding with agents page, the `/skill` and `@bsv/mcp` pages, `@bsv/simple-mcp` deprecated.
2. **Phase 2**: Rúnar contracts, contract review and multi-party funding in the skill; a contract-review tool and app scaffolding in `@bsv/mcp`; the `pay-per-call-shape-b` and `escrow-runar` samples. For the docs: a Rúnar page and sample links.
3. **Phase 3**: the 1Color sample once BRC-207 is in the official `wallet-toolbox`; the community skills list on the docs page; possibly `@bsv/mcp` over HTTP.

## Open questions for WriteChoice

1. **Final host**: the final URL for the pages and the docs MCP, and the move date.
2. **Redirect map**: old path to new path, including `bsvblockchain.org/docs/*`.
3. **Hosting `@bsv/mcp` over HTTP in phase 3**: would WriteChoice host it next to the docs MCP, and at what URL? Phase 1 ships it over stdio only.
4. **Community skills policy**: the Coding with agents draft lists community skills from `community-skills.yaml` in this repository, added by pull request with commit-pinned links. Who reviews submissions, what the bar is, and whether the docs page shows the list or links to it.
5. **Stable page ids**: can the paths in `content/docs-index.yaml` be treated as stable?
6. **Soft 404**: can missing pages answer a real 404?
7. **`llms.txt` on day one** at the final host?
8. **Review of the draft**: who reviews `coding-with-agents.md`, and in what format do you want it?
9. **Stub drafts**: should BSVA draft `guides/go-to-mainnet` and `wallets/bsv-desktop`?

## Since the first briefing

- The `bsv-mcp` install line now names the network: `claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp` (testnet is the default either way), and the client JSON carries `"env": { "BSV_NETWORK": "testnet" }` and the `bsv-docs` entry. Windsurf names the URL field `serverUrl`; VS Code uses a top-level `servers` key.
- The Codex lines are marked "verify": their syntax is not yet checked against `codex --help`.
- Host facts are more precise: `docs.bsvblockchain.org` answers `/docs/*.md` with a "Page Not Found" body behind HTTP 200, and the writedocs API reference trees (`/reference/arc/*`, `/reference/wallet-api/*`) live under `/reference/`, not `/docs/reference/`; `reference/networks` is a guide-site page, served under `/docs/` (`/docs/reference/networks.md`).
- `guides/services/broadcasting` and `guides/go-to-mainnet` now have drafts on writedocs; the other stubs are still scaffold placeholders.
- Fees, corrected: the first briefing's Networks row could be read as "use testnet's 1 sat/kB on testnet". The kit configures 100 sat/kB on both networks, never below what `GET /policy` reports, because an app paying testnet's 1 sat/kB minimum is refused on mainnet (code 465).
- The plugin pins `@bsv/mcp@2.0.0`, and the tipping sample ships as a container image.
- The example prompts on the draft page include "add tipping to my React app on BSV", the prompt the kit's phase-1 exit check uses.

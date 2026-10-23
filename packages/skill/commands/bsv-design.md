---
description: Interview, then write a BSV app design (custody shape, protocols, manifest, tx shapes, trust model)
argument-hint: [app name]
---

Design a BSV app with the user, then write the design doc into their project. Follow the bsv-dev skill (`${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/SKILL.md`) and its default decisions; where the user decides otherwise, record the decision and the reason. The app name is `$ARGUMENTS` if given; otherwise ask for it.

## 1. Interview

Ask these one at a time, and wait for each answer. Ask a follow-up when an answer leaves a money path unclear.

1. **What moves value?** Every money path: who pays whom, how much, how often, and what the payment unlocks.
2. **Who holds the keys?** For each money path, can the person whose money it is sign while they use the app, or must the app move money with no user present (payouts, bots, agents)? Use the decision questions in `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/custody-shapes.md`.
3. **Browser, server, or both?** Where does each part run, and which framework (Next, Express, Vite, other)?
4. **Repeated signing?** Does the app sign the same kind of thing again and again (moves, posts, records), and is any signing per counterparty?
5. **Tokens or contracts?** Does it issue or move tokens (1Color), or need a contract (covenant, escrow, multi-party settlement)?
6. **Mainnet timeline.** When should it reach mainnet, and who will operate it there?

Never ask for a private key, WIF, seed or recovery phrase; the design names environment variables, never their values.

## 2. Design doc

Write it to `docs/design/<YYYY-MM-DD>-<name>-design.md` in the user's project (today's date; `<name>` is the app name in kebab-case), creating the directory if needed. Show the user the draft before writing it. Sections:

1. **Summary.** What the app does, in one paragraph, and the one-line classification: custody shape per money path; payments only, contract, or token; browser, server, or both.
2. **Custody shape.** Shape A or B for each money path, with the reasons from `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/custody-shapes.md` and the trade-offs the user accepts (A: users install a BRC-100 wallet, served-code trust; B: operator custody, key and storage operations, fee budgets, write-ahead records). Prefer A when both work. For shape B, state the budgets (per action, per identity, per day) and the "fund the server" path.
3. **Protocols.** Every `protocolID` with its level and why: level 1 for anything signed repeatedly (one grouped grant covers every `keyID`), level 2 only where per-counterparty keys are needed, and BRC-29 payments as `[2, '3241645161d8']`. Every protocol name must match `/^[a-z0-9 ]+$/` (lowercase letters, digits and single spaces, 5 to 400 characters, not ending in ` protocol`); `my-app actions` fails at the first signature, `my app actions` works. Basket names in lowercase. See `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/wallet-brc100.md`.
4. **Manifest.** The `public/manifest.json` the app will ship, started from `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/assets/manifest.template.json` with `__APP_NAME__` replaced by a name that obeys the same protocol-name rule, the protocols above, identical `metanet` and `babbage` groupPermissions (G-03), and a small monthly spending allowance (G-04).
5. **Transaction shapes.** Each transaction kind: inputs, outputs (destination, amount, script type), who builds it, who signs it, and its fee. Size each fee at the configured rate (100 sat/kB by default) and never below the rate `GET /policy` reports, using the measured costs in `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/facts.md` (section "Fee rates and measured costs") as the estimate; state that the app sizes every real fee from the serialized draft, never from a guessed size. Flag any covenant larger than a few KB for a testnet gate script (G-29, G-33). When one money path has many updates between the same two parties, say whether it is a payment channel (`${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/payment-channels.md`) and name its open, update, close and timeout shapes.
6. **Arcade tracking plan.** The app has its own Arcade client with an `ARCADE_URL` setting, submits every transaction to it, and gates on its own `GET /tx/{txid}`; the agent's `arcade_*` MCP tools are for development only. A transaction counts as final at `SEEN_ON_NETWORK` or later with no `competingTxs`; a 2xx from `POST /tx` is provisional, `ACCEPTED_BY_NETWORK` is not enough, and nothing gates on `MINED`. Say how the app reads status after every POST, re-posts dropped transactions from stored hex, and applies the two-read dead rule. See `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/arcade-0conf.md`.
7. **Trust model.** From `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/threat-model.md`: served-code trust under the wallet's grouped grant; the 0-conf stance (miner collusion not modelled, an accepted residual risk); what the server can and cannot do with users' money. This becomes the app's G-34 paragraph.
8. **Testnet to mainnet.** One `BSV_NETWORK` variable (`testnet` default, `mainnet` only on purpose) drives the Arcade URL, WhatsOnChain base and wallet check; the app's own startup check refuses any other value and prints the mainnet banner; `getNetwork()` is checked before every money path. List the mainnet checklist items from `${CLAUDE_PLUGIN_ROOT}/skills/bsv-dev/references/testnet-to-mainnet.md` that apply, against the timeline from the interview.
9. **Open questions.** Anything the interview left undecided.

After writing, tell the user the path and the next step: build on testnet following the skill's operating procedure, then run `/bsv-review`.

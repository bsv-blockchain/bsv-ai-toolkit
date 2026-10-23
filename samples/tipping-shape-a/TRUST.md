# Trust model

bsv-tipping-demo is custody shape A: every key stays in the user's own BRC-100 wallet. The tipper's wallet builds, signs and broadcasts each tip. The creator's wallet derives the key a tip pays, and it alone decides whether a tip is its own. The relay (`server/`) stores tips, passes them to Arcade and reads their status. It holds no key and signs nothing.

## Served-code trust

Whoever serves this JavaScript controls what the page asks the wallet to do. That means the operator of the host, anyone who can change the image or the tag it runs, and anything that can inject script into the page. Under the grouped grant in `public/manifest.json`, the page can do these things without another prompt:

- sign anything under the tips protocol `[1, 'bsv tipping demo tips']` (level 1: every key ID and counterparty)
- derive BRC-29 keys for the user's own payments (`[2, '3241645161d8']`, counterparty `self`)
- use the `bsv tipping demo` basket
- spend up to the monthly allowance: 10,000 sats

The allowance is small on purpose. It is the most a hostile or compromised copy of this page can spend from a wallet that granted it, each month, without asking. Anything above it makes the wallet prompt. Users who want a tighter bound can lower or revoke the grant in their wallet. Operators should deploy a pinned `sha-…` image tag (see [HOSTING.md](HOSTING.md)), so the served code changes only when they change it.

## 0-conf stance

A tip is received when Arcade reports its transaction at `SEEN_ON_NETWORK` or later with no `competingTxs`, and the creator's wallet has internalized it. The app does not wait for confirmation in a block, and nothing in it counts blocks. That is the finality point the kit uses for payments of this size (guardrails G-10 and G-14). The remaining failures are drops and evictions, and the app handles them as follows:

- The relay re-posts a transaction Arcade has no record of.
- A tip counts as failed only after `REJECTED` on two reads at least 20 seconds apart, with a re-post between them (the two-read dead rule).
- A `REJECTED` that blames a parent or the inputs is flagged as possibly not final, and is read again.

A double spend that reaches the network first shows up as a competing transaction, and the creator page does not collect the tip.

## What the relay can and cannot do

The relay **can**:

- drop, delay or hide a tip notice, so the creator page does not see a tip, or sees it late
- refuse or rate-limit posts and reads
- report a wrong status, which at worst delays a collect: the creator's wallet still verifies what it internalizes
- see every remittance (sender identity key, derivation prefix and suffix, amount) and the transactions they belong to, and so link tippers to tips. So can everyone else who opens the relay (see **Remittances are public** under [Residual risks](#residual-risks))
- on testnet with `CREATOR_IDENTITY_KEY` unset, keep whichever creator claim reached it first

The relay **cannot**:

- spend a tip: the output is locked to a key only the creator's wallet can derive
- redirect a tip: the tipper's wallet chose the output and signed the transaction before the relay saw it
- forge a tip: a posted transaction is checked against its own BEEF, a remittance that does not derive the output's key is refused by the creator's wallet, and the creator collects only what Arcade reports as seen with no competitor
- make the creator sign anything: creator signatures (`claim:…`, `internalized:…`) are made in the creator's wallet, over messages that name the deployment's origin

The tip stands without the relay. The tipper's wallet broadcast it, and the AtomicBEEF the wallet returned holds everything needed to collect it. If the relay refuses it or is gone, the tipper's browser keeps the record (the derivation, the transaction and the amount) and posts it again on every visit. A tip the relay refuses as too large (HTTP 413) is never posted again, since that cannot change: it is listed as an unfinished tip with **Copy details**. A tip whose transaction the wallet never returned is listed as an unfinished tip with **Copy details**. With the details and the transaction (on the network under its txid), the creator can collect a tip in any BRC-100 wallet.

## Residual risks

- **Remittances are public.** `GET /api/tips` and the `tip` event on `/api/events` need no sign-in. They carry every candidate's sender identity key, derivation prefix and suffix, amount and txid, to anyone who opens the relay, not just to the relay and the creator. So anyone can link a tipper's identity key to their tips and amounts. Nobody can spend a tip with them: the output's key still derives only in the creator's wallet. An app that must keep tippers private needs an authenticated creator feed instead.
- **Candidate-slot exhaustion.** Anyone who sees a tip's transaction can post it with made-up remittances. The relay keeps at most 64 remittance candidates per tip, each with the BEEF it came with, so a determined poster spread over enough addresses could fill the slots before the tipper's own post arrives. The tipper's post then gets 409. The tipper's browser keeps the record and posts it again on every visit, so the derivation is not lost, but the relay cannot pass it to the creator page. Collecting that tip means reading the record (`tip:pending:…`) from the tipper's browser storage, outside this app. The creator's wallet still refuses every made-up candidate.
- **Lookalike-origin phishing of creator signatures.** Creator signatures name the relay's `PUBLIC_ORIGIN` and come from the page the creator has open. A lookalike site can proxy the real relay's `/api/config` and ask the creator's wallet to sign messages that name the real origin. It needs a grant from the creator's wallet for its own origin, or a prompt the creator accepts. With a claim signature it can only make the creator's own key the creator, which matters only in testnet's first-claim mode. With an `internalized:` signature it can make the relay's list show a tip as received. Neither moves money. Creators should check the address bar before approving a prompt, and set `CREATOR_IDENTITY_KEY`.
- **`internalizedAt` is a label, not evidence.** The relay records a creator-signed "internalized" report and shows the tip as received. The creator page never decides from it whether to collect. It collects from its own wallet's results: what `internalizeAction` accepted, remembered in this browser per identity key. Anyone building on this sample must keep it that way.
- **Wallets other than wallet-toolbox.** The creator page relies on `internalizeAction` (`protocol: 'wallet payment'`) refusing a remittance that does not derive the output's key. That behaviour is verified against `@bsv/wallet-toolbox` 2.14.9 only (BSV Desktop's engine). A wallet that does not check might internalize a front-run candidate's wrong derivation, and so hold an output it cannot spend, before it reaches the tipper's real candidate. The page checks first that each candidate's output exists, is P2PKH and has the claimed amount. A wallet that rejects with a different error leaves the tip uncollected ("gave up"), never wrongly received.
- **`/api/tx` is an open, rate-limited read proxy.** `GET /api/tx/:txid` reads any txid from the relay's Arcade (not only a stored tip's ancestors), so the creator page can complete a BEEF without talking to Arcade itself. Each client address gets a burst of 30, then 120 a minute. Scoping it to stored ancestors is left for later.
- **The client address comes from `TRUST_PROXY`.** Rate limits and event-stream caps are per client address, as the relay sees it. If `TRUST_PROXY` does not match the actual proxy setup, clients either share one bucket or can claim any address (see [HOSTING.md](HOSTING.md#environment)).
- **First-claim creator mode is for testnet only.** With `CREATOR_IDENTITY_KEY` unset, whoever claims `/creator` first collects every tip. The relay refuses to start on mainnet without the variable. On a public testnet host, set it anyway.

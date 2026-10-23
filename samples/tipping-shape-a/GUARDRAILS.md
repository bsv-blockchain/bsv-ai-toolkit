# Guardrails

How this app meets the kit's guardrails (`content/guardrails.yaml`) that apply to a shape-A app: every rule `check_guardrails` checks statically, plus the manual ones this app answers. Paths are relative to this folder.

| id | how this app satisfies it | file |
| --- | --- | --- |
| G-01 | Connects with `WalletClient('auto', originator)`, waits on `waitForAuthentication()` (never `isAuthenticated()`), and reads identity from `getPublicKey({ identityKey: true })`. | `web/wallet.ts` |
| G-02 | `BSV_NETWORK` defaults to testnet, and anything other than `testnet` or `mainnet` refuses to boot. The wallet's `getNetwork()` is read again before every tip and every collect, and a mismatch blocks both. | `server/config.ts`, `scripts/network-guard.sh`, `web/wallet.ts`, `web/tip.ts`, `web/collect.ts` |
| G-03 | `public/manifest.json` carries identical `metanet` and `babbage` `groupPermissions`. The relay serves it as `application/manifest+json` with `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`, before static files and the SPA fallback. | `public/manifest.json`, `server/app.ts` |
| G-04 | Creator signatures use the level-1 protocol `[1, 'bsv tipping demo tips']`. The level-2 BRC-29 entry names `counterparty: 'self'`. The spending allowance is 10,000 sats a month. | `public/manifest.json` |
| G-05 | Login fires one harmless protected `getPublicKey` under the tips protocol, without awaiting it, to raise the grouped prompt. | `web/wallet.ts` |
| G-06 | No private key anywhere in `web/` or `server/`. The tipper's and the creator's wallets hold every key. The relay verifies creator signatures as `'anyone'`. Derivation prefixes and suffixes are random and carry no secret. | `web/brc29.ts`, `server/auth.ts` |
| G-09 | The relay broadcasts only to Arcade (`POST /tx`, `text/plain`, Extended Format from the tip's BEEF). `ARCADE_URL` defaults to the public instance for the network, and a host of the other network is refused. | `server/arcade.ts`, `server/beef.ts`, `server/config.ts` |
| G-10 | A POST 2xx is provisional. The verdict comes from reading `GET /tx/{txid}`: `seen-no-competitor` at `SEEN_ON_NETWORK` or later with no `competingTxs`. The creator page collects only at that verdict. | `server/arcade.ts`, `web/collect.ts` |
| G-12 | Every known txid is read from Arcade, through the relay: tip status, and ancestor `rawTx` for completing a BEEF (`GET /api/tx/:txid`). The page's WhatsOnChain link is for people to look at a transaction, never a data source. | `server/routes.ts`, `web/pages/Tipper.tsx` |
| G-13 | Every tip, although the tipper's wallet already broadcast it, is posted to the relay and submitted to its own Arcade. A client-reported txid is never evidence: the relay checks the transaction against its BEEF, and the verdict comes from Arcade. | `server/routes.ts` |
| G-14 | No confirmation waits and no block counts. Drops are handled by re-posting, and the two-read dead rule (`REJECTED` twice, 20 s apart, with a re-post between). | `web/collect.ts`, `server/routes.ts` |
| G-15 | Every Arcade request has a 10 s timeout, and every relay request from the page has one too. The tip POST waits for `SEEN_ON_NETWORK` for at most 15 s. Collect retries are bounded (10 s, 30 s, then 60 s three times). | `server/arcade.ts`, `web/api.ts`, `web/collect.ts` |
| G-16 | Arcade's `rawTx` is re-read as Extended Format and returned as a plain transaction before it is merged into a BEEF. Missing ancestors come from Arcade by txid, never from an indexer one at a time. | `server/beef.ts`, `web/collect.ts` |
| G-21 | Tips pay a BRC-29-derived key of the creator, with the remittance (sender identity key, derivation prefix and suffix) saved before `createAction`. The creator collects automatically with `internalizeAction` + `paymentRemittance`, from a complete AtomicBEEF. For the rule's own-derivation check the creator relies on the wallet's own refusal: `@bsv/wallet-toolbox` 2.14.9's `internalizeAction` derives the key for self from the remittance and refuses a `paymentRemittance` whose key does not derive the output's. The app makes no `getPublicKey({ forSelf: true })` call of its own, which would prompt once per tipper. | `web/brc29.ts`, `web/tip.ts`, `web/collect.ts` |
| G-34 | The trust model is stated: served-code trust under the grouped grant, the 0-conf stance, and what the relay can and cannot do. | `TRUST.md`, `README.md` |

`check_guardrails` also passes G-08 (creator signatures sign `data` in `web/wallet.ts`; nothing is signed with `hashToDirectlySign`), G-25 (no Rúnar contract code) and G-31 (`@bsv/sdk` 3.2.1 and `@bsv/wallet-toolbox` 2.14.9 match the kit's pins). Among the manual items, the image build runs the deploy-image smoke checks (G-32, `Dockerfile`), and `pnpm gate` is the testnet gate (G-33, `scripts/gate.ts`).

The shape-B rules (G-17, G-18, G-19, G-23, G-24) do not apply: this app has no server wallet, no coins to keep books on, and no operator-paid fees. Neither do the contract rules (G-25 to G-28): it has no script contracts. The report says "shape A+B" only because the testnet gate (`scripts/gate-wallet.ts`) uses `@bsv/wallet-toolbox` for its headless test wallets. They are CI tooling and are not shipped in the image.

To check, from this folder (after `pnpm -F @bsv/mcp build` at the repo root, once):

```bash
pnpm guardrails
```

Expected: `check_guardrails: 0 errors`.

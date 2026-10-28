# BSV AI DevKit phase 1c: `samples/tipping-shape-a`, testnet gate, WriteChoice hand-off and exit checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the phase-1 reference app `samples/tipping-shape-a` (Vite + React web app plus a stateless relay with SQLite and SSE, one container, GHCR image), a testnet gate script that creates the CI wallet safely, the WriteChoice briefing and draft "Coding with agents" page, and the manual phase-1 exit checklist with the `docs/evals/` protocol.

**Architecture:** One Node process (`server/`) serves the built web app, `public/manifest.json` with the right headers, `/api/*` (tips, config, SSE) and `/health` on one port, so manifest, app and relay share one origin (the wallet `originator`). The relay holds no key: it re-submits each tip's EF hex to its Arcade, reads status, stores the remittance in SQLite keyed by txid, and pushes it over SSE. The web app (`web/`) does shape A end to end: login, network gate, manifest, BRC-29 tip via `createAction`, and creator-side collection with AtomicBEEF + `internalizeAction` at 0-conf. The sample depends only on npm packages (no workspace packages) so the folder can be copied to the demos org unchanged.

**Tech Stack:** Node 22, TypeScript 5.8, Vite 7 + React 19, Express 5, `better-sqlite3` ^12, `@bsv/sdk` 3.2.1, `@bsv/wallet-toolbox` 2.14.9 (gate only, devDependency), `vitest`, Docker multi-stage (`node:22-alpine`, non-root), `docker/build-push-action@v6`, GHCR.

**Spec:** `docs/superpowers/specs/2026-10-22-bsv-ai-devkit-design.md` (§8.1 sample and hosting, §9 CI wallet, §10 hand-off, §11 phase-1 exit). Plan 1a (`docs/superpowers/plans/2026-10-22-p1a-foundation-and-mcp.md`) defines the content schema, `versions.json#services.arcade.probeTxid`, tool names (`check_guardrails`, `docs_url`), env var names, CI job names (`build-test`, `content`, `skill`, `freshness`, `publish`) and the BEEF/EF detection rules; plan 1b defines `scripts/network-guard.sh`, `scripts/arcade-check.sh` and `assets/manifest.template.json`. Source lessons (LOCAL, never committed): the playbook §4.6, §4.7, §4.8, §4.11, §5; the handoff "Wallet integration", "Rules the MCP should encode". Nothing from the earlier apps is copied; the sample is written fresh from the spec and the facts in `content/`.

## Global Constraints

- Branch `feat/bsv-ai-devkit-p1` (continues plans 1a and 1b); every task ends with a commit ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Public, MIT. No private key, WIF, seed or funded key in the repo, tests, fixtures, logs, Docker image or workflow output. The gate's root key lives only in a file outside the repo (`$BSV_GATE_KEY_FILE`, default `~/.bsv-gate/tipping-shape-a.key`, mode 0600) or in the secret `BSV_TESTNET_GATE_KEY`; the script prints only an address and an identity key, never the key.
- Network tests run only with `BSV_MCP_NETWORK_TESTS=1`; the gate `run` additionally requires `BSV_TESTNET_GATE_KEY` or the key file and refuses `BSV_NETWORK=mainnet` outright (exit 2).
- The sample passes `check_guardrails` with zero `error` findings (CI job `sample`), and a deliberately broken copy (ARC class, `isAuthenticated`, mainnet default, WoC ancestry loop, missing manifest) reports each (plan 1a `broken-a` fixture already pins this; the sample's own test re-checks on a mutated copy).
- Env vars read by the sample: `BSV_NETWORK` (`testnet` default | `mainnet`), `ARCADE_URL` (empty = public instance per network: testnet `https://arcade-testnet-us-1.bsvblockchain.tech`, mainnet `https://arcade-us-1.bsvblockchain.tech`), `PUBLIC_ORIGIN` (e.g. `https://tipping.bsvb.tech`; this is the wallet `originator`), `PORT` (default 8080), `DATA_DIR` (default `./data`, SQLite file `tips.sqlite`), `CREATOR_IDENTITY_KEY` (optional 33-byte hex; when unset the first wallet that claims the creator page becomes the creator and is persisted). Never a key variable.
- The one network switch is `BSV_NETWORK`; `scripts/network-guard.sh` (a copy of plan 1b's script, kept identical by a test) runs at boot.
- Arcade is the only broadcaster and the only status source for a known txid; the relay never calls WhatsOnChain. Final for the app = `SEEN_ON_NETWORK`+ with no `competingTxs`. No confirmation waits, no `MINED` branches.
- Image name `ghcr.io/bsv-blockchain/bsv-tipping-demo`, platforms `linux/amd64,linux/arm64`, tags `latest` (default branch), sha, semver `{{version}}` and `{{major}}.{{minor}}`; built on pushes to `main` that touch `samples/tipping-shape-a/**` and on `v*` tags.
- Docs install names stay `bsv-docs` and `bsv-mcp`.

## Review Focus

1. A tip POSTed twice with the same txid (browser retry after a timeout): the relay must answer 200 with the stored record and must not re-insert or re-push a duplicate SSE event (Task 2 test `POST /api/tips is idempotent by txid`).
2. A tip whose BEEF parses but whose output 0 does not pay the creator's BRC-29 key (wrong counterparty or tampered remittance): the creator page must refuse to `internalizeAction` and show "not for me" instead of calling the wallet (Task 3 test `collector refuses an output that is not for self`).
3. Arcade answers 2xx then `REJECTED` within milliseconds: the relay must store `verdict: 'terminal'` and the UI must show it as failed, never as received (Task 2 test `2xx then REJECTED is stored as terminal`).
4. The SSE route behind a buffering proxy: the response must send headers immediately, a `: keepalive` comment every 15 s and `X-Accel-Buffering: no`, so a proxy that honours it does not stall the creator page (Task 2 test `SSE sends headers, keepalive and X-Accel-Buffering: no`).
5. `BSV_NETWORK=mainnet` set on the relay while the tipper's BSV Desktop is on testnet: the web app must refuse the tip path with a visible mismatch message before building any transaction (Task 3 test `network mismatch blocks the tip path`).

---

### Task 1: Sample scaffold: workspace package, Vite + React web, Express relay skeleton, boot guard

**Files:**
- Create: `samples/tipping-shape-a/package.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `index.html`, `web/main.tsx`, `web/App.tsx`, `web/config.ts`, `server/index.ts`, `server/config.ts`, `server/app.ts`, `scripts/network-guard.sh` (copy of plan 1b's), `env.example`, `public/manifest.json`, `README.md` (stub, completed in Task 5), `.dockerignore`
- Test: `samples/tipping-shape-a/test/app.test.ts`

**Interfaces:**
- Produces: `package.json` `name "bsv-tipping-demo"`, `version "0.1.0"`, private, `"type": "module"`, scripts `dev` (vite + `tsx watch server/index.ts` via `concurrently`), `build` (`vite build && tsc -p tsconfig.server.json`), `start` (`bash scripts/network-guard.sh && node dist/server/index.js`), `test` (`vitest run`), `gate` (`tsx scripts/gate.ts`, Task 4), `guardrails` (`node ../../packages/mcp/build/cli/check-guardrails.js .`: plan 1a has no such CLI; add it there in this task as `packages/mcp/src/cli/check-guardrails.ts` printing the report JSON and exiting 1 on any error finding). `server/config.ts`: `loadServerConfig(env): { network: 'testnet'|'mainnet'; arcadeUrl: string; publicOrigin: string; port: number; dataDir: string; creatorIdentityKey?: string }` (same validation as plan 1a `loadConfig`, with `publicOrigin` required in production: `NODE_ENV=production` and unset → throw). `server/app.ts`: `createApp(cfg, deps: { db: Db; arcade: Arcade; fetchImpl?: typeof fetch }): express.Express` (Task 2 fills routes; this task mounts: `GET /health` → `{ ok: true, network, arcadeUrl, version }`; `GET /manifest.json` → `public/manifest.json` with `Content-Type: application/manifest+json`, `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`, registered BEFORE `express.static('dist/web')` and before the SPA fallback; SPA fallback for non-`/api` GETs). `web/config.ts`: `fetchConfig(): Promise<{ network, creatorIdentityKey?, originator, arcadeUrl }>` from `GET /api/config` (Task 2). `public/manifest.json`: from plan 1b's template with `__APP_NAME__` → `bsv-tipping-demo`, protocol `[1, 'bsv-tipping-demo tips']`, BRC-29 entry, basket `bsv-tipping-demo`, allowance 10000.

- [ ] **Step 1: Write the failing tests** (`supertest` devDependency):
  - `GET /health returns ok with the network`.
  - `manifest is served with manifest+json, open CORS and no-store`.
  - `manifest has identical metanet and babbage groupPermissions and one level-1 protocol`.
  - `loadServerConfig rejects BSV_NETWORK=main` and `defaults ARCADE_URL per network`.
  - `network-guard.sh is identical to the skill's` (byte-compare with `packages/skill/skills/bsv-dev/scripts/network-guard.sh`).

- [ ] **Step 2: Run to verify failure** — Run: `pnpm -F bsv-tipping-demo test` — Expected: FAIL

- [ ] **Step 3: Scaffold the package, write `config.ts`, `app.ts`, `index.ts` (listen on `PORT`, log one line), the Vite app shell (`App.tsx` renders a header with the network badge and two routes `/` tipper, `/creator` creator; routing via `window.location.pathname`, no router dependency), and plan 1a's `check-guardrails` CLI**

- [ ] **Step 4: Run to verify pass**: `pnpm install && pnpm -F bsv-tipping-demo build && pnpm -F bsv-tipping-demo test` — Expected: PASS (6 tests); `pnpm -F @bsv/mcp build && pnpm -F bsv-tipping-demo guardrails` exits 0 (no errors on the skeleton).

- [ ] **Step 5: Commit**

```bash
git add samples/tipping-shape-a packages/mcp pnpm-lock.yaml
git commit -m "feat(sample): tipping-shape-a scaffold: one-origin relay + Vite app, manifest headers, boot guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Relay: SQLite store, Arcade submit/status, idempotent tips route, SSE

**Files:**
- Create: `server/db.ts`, `server/arcade.ts`, `server/routes.ts`, `server/sse.ts`, `server/beef.ts`
- Modify: `server/app.ts`
- Test: `samples/tipping-shape-a/test/relay.test.ts`, fixtures `test/fixtures/{status-seen,status-rejected,submit-202}.json` (copy the literals from plan 1a's fixtures)

**Interfaces:**
- Produces:
  ```ts
  // db.ts (better-sqlite3)
  export interface TipRow { txid: string; beefHex: string; outputIndex: number; satoshis: number; senderIdentityKey: string; derivationPrefix: string; derivationSuffix: string; txStatus: string; verdict: string; competingTxs: string[]; extraInfo?: string; receivedAt: string; updatedAt: string; internalizedAt?: string }
  export interface Db { insertTip(row: Omit<TipRow,'receivedAt'|'updatedAt'>): { inserted: boolean }; getTip(txid): TipRow | undefined; listTips(limit?: number): TipRow[]; updateStatus(txid, s: { txStatus; verdict; competingTxs; extraInfo? }): void; markInternalized(txid): void; getSetting(k): string | undefined; setSetting(k, v): void; close(): void }
  export function openDb(file: string): Db   // schema: tips(txid PK, beef_hex, output_index, satoshis, sender_identity_key, derivation_prefix, derivation_suffix, tx_status, verdict, competing_json, extra_info, received_at, updated_at, internalized_at), settings(key PK, value); WAL mode
  // arcade.ts: the same rules as plan 1a's client, ~80 lines, no shared code
  export type Verdict = 'seen-no-competitor'|'on-network-not-seen'|'pending'|'terminal'|'no-verdict'
  export function verdictOf(s: { txStatus: string; competingTxs?: string[] }): Verdict
  export class Arcade { constructor(baseUrl: string, fetchImpl?: typeof fetch, timeoutMs = 10000); submit(hex: string): Promise<{ postStatus: number; body: any; transient: boolean }>; status(txid: string): Promise<any | { notFound: true }>; waitForSeen(txid: string, timeoutMs: number, intervalMs = 1000) }
  // beef.ts
  export function efHexFromAtomicBeef(beefHex: string, txid: string): string   // Transaction.fromAtomicBEEF(bytes) (verify tx.id('hex') === txid, else throw) → tx.toHexEF()
  export function outputPaysScript(beefHex: string, outputIndex: number): { lockingScriptHex: string; satoshis: number }
  // sse.ts
  export class Broadcaster { add(res: express.Response): void; emit(event: 'tip'|'status', data: object): void }   // writes headers Content-Type text/event-stream, Cache-Control no-cache, Connection keep-alive, X-Accel-Buffering no; flushHeaders(); ': keepalive\n\n' every 15 s
  // routes.ts: mountApi(app, cfg, { db, arcade, broadcaster })
  // GET /api/config → { network, creatorIdentityKey, originator: cfg.publicOrigin, arcadeUrl }
  // POST /api/creator { identityKey } → claims when cfg.creatorIdentityKey unset and no setting; 409 if already claimed by another key
  // POST /api/tips { txid, beef, outputIndex, satoshis, remittance: { senderIdentityKey, derivationPrefix, derivationSuffix } } → validates (txid 64 hex, beef hex, tx id matches), inserts (idempotent: existing → 200 stored row), submits EF hex to Arcade, waits for seen up to 15 s, stores status+verdict, emits 'tip' (only on first insert) and 'status'; 400 on bad input; 502 with { transient: true } when Arcade is UNREACHABLE (row kept with verdict 'pending')
  // GET /api/tips → listTips(100)
  // GET /api/tips/:txid/status → live Arcade read, updates the row, emits 'status' on change
  // POST /api/tips/:txid/internalized → markInternalized (creator page reports success)
  // GET /api/events → SSE
  ```

- [ ] **Step 1: Write the failing tests** (mock fetch; `openDb(':memory:')`; a real AtomicBEEF hex fixture built in the test with `@bsv/sdk`: a P2PKH source tx → child spending it, `child.toAtomicBEEF()` via `Beef` merge; no keys beyond `PrivateKey.fromRandom()` in-memory):
  - `POST /api/tips submits EF (not BEEF) to {arcade}/tx as text/plain` (asserts the posted body starts with the 8-char version + `0000000000ef`).
  - `POST /api/tips is idempotent by txid` (two POSTs → one row, one 'tip' SSE event, second response equals first).
  - `2xx then REJECTED is stored as terminal` (routes: 202, then status `REJECTED` → row `verdict 'terminal'`, response `verdict 'terminal'`).
  - `txid that does not match the BEEF is 400`.
  - `Arcade unreachable keeps the row as pending and answers 502 transient`.
  - `SSE sends headers, keepalive and X-Accel-Buffering: no` (use fake timers; read the raw response stream for `: keepalive`).
  - `creator claim: first claim wins, second different key is 409`.
  - `GET /api/tips/:txid/status re-reads Arcade and emits status on change`.
  - `relay never calls whatsonchain` (grep `server/**/*.ts` for `whatsonchain` → none).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement the five modules and mount them in `app.ts`**

- [ ] **Step 4: Run to verify pass** — Run: `pnpm -F bsv-tipping-demo test` — Expected: PASS; `pnpm -F bsv-tipping-demo guardrails` exit 0.

- [ ] **Step 5: Commit**

```bash
git add samples/tipping-shape-a
git commit -m "feat(sample): relay with SQLite, Arcade submit/status, idempotent tips, SSE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Web app: wallet login, network gate, tip flow, creator collection

**Files:**
- Create: `web/wallet.ts`, `web/brc29.ts`, `web/tip.ts`, `web/collect.ts`, `web/pages/Tipper.tsx`, `web/pages/Creator.tsx`, `web/components/TipList.tsx`, `web/api.ts`
- Modify: `web/App.tsx`
- Test: `samples/tipping-shape-a/test/web.test.ts` (pure modules with a fake `WalletInterface`; no DOM tests beyond rendering with `react-dom/server`)

**Interfaces:**
- Consumes: relay routes (Task 2); `WalletClient` 3.2.1 (`connectToSubstrate()`, `waitForAuthentication()`, `getPublicKey`, `getNetwork()`, `createAction`, `internalizeAction`).
- Produces:
  ```ts
  // wallet.ts
  export const ORIGINATOR = () => window.location.host           // one origin
  export const TIPS_PROTOCOL: [1, string] = [1, 'bsv-tipping-demo tips']
  export async function login(wallet = new WalletClient('auto', ORIGINATOR())): Promise<{ wallet: WalletInterface; identityKey: string; network: 'testnet'|'mainnet' }>
  // connectToSubstrate → waitForAuthentication (never isAuthenticated) → getPublicKey({identityKey:true}) → getNetwork; then fire-and-forget wallet.getPublicKey({ protocolID: TIPS_PROTOCOL, keyID: 'permissions', counterparty: 'self' }).catch(() => {})
  export function assertNetwork(walletNet: string, appNet: string): void   // throws Error(`wallet is on ${walletNet}, app is on ${appNet}`)
  // brc29.ts
  export const BRC29: [2, '3241645161d8']
  export function newDerivation(): { derivationPrefix: string; derivationSuffix: string }   // 16 random bytes each, base64
  export async function payeeLockingScript(wallet, creatorIdentityKey, prefix, suffix): Promise<string>   // getPublicKey({ protocolID: BRC29, keyID: `${prefix} ${suffix}`, counterparty: creatorIdentityKey }) → P2PKH lock hex
  export async function isForSelf(wallet, senderIdentityKey, prefix, suffix, lockingScriptHex): Promise<boolean>   // forSelf: true derivation → compare
  // tip.ts
  export async function sendTip(wallet, cfg, creatorIdentityKey, satoshis, api): Promise<{ txid: string; verdict: string }>
  // newDerivation → persist {prefix,suffix} to localStorage under `tip:pending:<ts>` BEFORE createAction → createAction({ description: 'Tip', outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 tip' }], options: { randomizeOutputs: false, acceptDelayedBroadcast: false } }) → POST /api/tips { txid, beef: hex(tx), outputIndex: 0, satoshis, remittance } → clear the pending key
  // collect.ts
  export async function buildAtomicBeef(beefHex: string, txid: string, arcadeStatus: (txid) => Promise<any>): Promise<number[]>
  // Beef.fromString(beefHex); if !beef.isValid(): for each txid-only entry fetch Arcade status, require rawTx, Transaction.fromHexEF(rawTx).toHex() → beef.mergeRawTx; return beef.toBinaryAtomic(txid)
  export async function collectTip(wallet, tip: TipRow, api, deps: { delaysMs?: number[] /* default [10000, 30000, 60000, 60000, 60000] */ }): Promise<'accepted'|'not-for-me'|'gave-up'>
  // isForSelf first ('not-for-me' → never calls internalizeAction); then internalizeAction({ tx, outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix } }], description: 'Tip received' }) with retries at the delays; on accepted → POST /api/tips/:txid/internalized
  ```
  Pages: `Tipper.tsx` (connect button → identity, network badge, mismatch banner that disables the tip form; amount input ≥ 546; "Tip" shows a summary (amount, fee note, network) before calling `sendTip`; result line with Arcade verdict and a link to `https://test.whatsonchain.com/tx/<txid>` or mainnet). `Creator.tsx` (connect → claim or verify creator identity; opens `EventSource('/api/events')`; on `tip` calls `collectTip`; shows the list with live status via `TipList`). `TipList.tsx` renders txid (short), sats, `txStatus`, `verdict` badge (`seen-no-competitor` → "received", `terminal` → "failed", else "pending"), never the word "confirmation".

- [ ] **Step 1: Write the failing tests** (fake wallet implementing the five methods; record calls):
  - `login never calls isAuthenticated and fires the permission trigger without awaiting it`.
  - `network mismatch blocks the tip path` (`assertNetwork('mainnet','testnet')` throws; `sendTip` not called by Tipper when mismatched: render `Tipper` to string with a mismatched state → contains "wallet is on mainnet").
  - `sendTip persists the derivation before createAction` (fake `createAction` asserts `localStorage` already has the pending entry; use a Map-backed `localStorage` shim).
  - `sendTip passes randomizeOutputs false and acceptDelayedBroadcast false`.
  - `collector refuses an output that is not for self` (fake `getPublicKey` returns a different key under `forSelf` → `'not-for-me'`, `internalizeAction` calls = 0).
  - `buildAtomicBeef merges Arcade rawTx re-read as plain` (BEEF with a txid-only parent; fake status returns EF rawTx; result parses with `Transaction.fromAtomicBEEF`).
  - `collectTip retries at 10/30/60 s and reports accepted` (fake timers; `internalizeAction` fails twice then `{ accepted: true }`; delays observed `[10000, 30000]`).
  - `UI never says confirmation` (grep `web/**` for `/confirmation/i` → none).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement the modules and pages**

- [ ] **Step 4: Run to verify pass**: `pnpm -F bsv-tipping-demo test && pnpm -F bsv-tipping-demo build && pnpm -F bsv-tipping-demo guardrails` — Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
git add samples/tipping-shape-a
git commit -m "feat(sample): wallet login, BRC-29 tip flow, creator collection at 0-conf

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Testnet gate script and the CI wallet

**Files:**
- Create: `samples/tipping-shape-a/scripts/gate.ts`, `scripts/gate-wallet.ts`
- Modify: `package.json` (devDependency `@bsv/wallet-toolbox 2.14.9`, `tsx`), `.gitignore` (root: `.bsv-gate/`, `*.key`)
- Test: `samples/tipping-shape-a/test/gate.test.ts`

**Interfaces:**
- Consumes: `Setup.createWalletSQLite({ env, rootKeyHex, filePath, databaseName })` (wallet-toolbox 2.14.9; `env: SetupEnv { chain: 'test'|'main', identityKey, identityKey2, filePath, taalApiKey, devKeys, mySQLConnection }`), `Setup.getKeyPair(privHex): { privateKey, publicKey, address }`, `Setup.fundWalletFromP2PKHOutpoints(wallet, outpoints, p2pkhKey, inputBEEF?)`, `Services` with `WalletServicesOptions.arcadeUrl` (verified in 2.14.9 types; `Setup.createWallet` itself does not take service options, so `gate-wallet.ts` builds the wallet the way `Setup.createWallet` does (read `node_modules/@bsv/wallet-toolbox/out/src/Setup.js`) but constructs `new Services({ ...Services.createDefaultOptions(chain), arcadeUrl })` — mark any divergence in a comment).
- Produces:
  ```ts
  // gate-wallet.ts
  export function keyFilePath(env = process.env): string            // BSV_GATE_KEY_FILE ?? ~/.bsv-gate/tipping-shape-a.key
  export function loadOrCreateRootKey(opts: { create: boolean; env? }): { rootKeyHex: string; source: 'env'|'file'|'created' }   // env BSV_TESTNET_GATE_KEY wins; else file; else create (random 32 bytes) only when create=true, write 0600
  export function derive(rootKeyHex: string): { fundingAddress: string; tipperIdentityKey: string; creatorRootKeyHex: string; creatorIdentityKey: string }
  // tipper wallet root = rootKeyHex; creator wallet root = sha256(rootKeyHex || 'creator') hex (deterministic, G-24); fundingAddress = Setup.getKeyPair(rootKeyHex).address
  export async function openGateWallet(rootKeyHex: string, name: 'tipper'|'creator', network, arcadeUrl, dataDir): Promise<{ wallet; identityKey; close(): Promise<void> }>
  // gate.ts subcommands (BSV_NETWORK must be testnet; mainnet → exit 2 'gate runs on testnet only')
  //   init      → creates the key if absent, prints `funding address: <addr>` and `tipper identity: <key>`, `creator identity: <key>`; prints NOTHING else
  //   address   → prints the two lines without creating
  //   sweep --txid <txid> [--vout n]  → fetches the faucet tx hex from Arcade (if known) else WhatsOnChain `/tx/{txid}/hex` (the one allowed WoC use: Arcade never saw the faucet tx) verifying `Transaction.fromHex(hex).id('hex') === txid`, fetches the merkle proof `/tx/{txid}/proof/tsc` when mined to build a BEEF, calls Setup.fundWalletFromP2PKHOutpoints(wallet, [`${txid}.${vout}`], keyPair, beef); prints the result rows
  //   run [--relay http://127.0.0.1:8080] [--sats 1000] → starts the relay in-process on a free port with CREATOR_IDENTITY_KEY=<creator identity> unless --relay given; tipper wallet performs the same steps as web/tip.ts (derivation, P2PKH to the creator's BRC-29 key, createAction with randomizeOutputs:false, acceptDelayedBroadcast:false, POST /api/tips); asserts the relay answers verdict 'seen-no-competitor' within 20 s; creator wallet runs collect.ts's buildAtomicBeef + internalizeAction and asserts { accepted: true }; prints a table `| step | txid | bytes | fee sats | txStatus | verdict | ms |` and writes it to `docs/evals/gate-<YYYY-MM-DD>.md`; prints `probeTxid: <txid>` for versions.json; exit 1 on any failed assertion
  ```

- [ ] **Step 1: Write the failing tests** (no network): `init writes the key file with mode 0600 and prints only an address and identities` (temp `BSV_GATE_KEY_FILE`; stdout matches `/^funding address: [1mn][1-9A-HJ-NP-Za-km-z]{25,34}\ntipper identity: [0-9a-f]{66}\ncreator identity: [0-9a-f]{66}\n$/`; stdout does not contain the key hex); `env key wins over the file`; `derive is deterministic`; `mainnet is refused with exit 2`; `run refuses without a key` (exit 2, message names `BSV_TESTNET_GATE_KEY`); `it.skipIf(!process.env.BSV_MCP_NETWORK_TESTS)('run completes one tip at 0-conf on testnet')` (requires a funded key; asserts the printed table has a `seen-no-competitor` row and `accepted`).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement `gate-wallet.ts` and `gate.ts`**

- [ ] **Step 4: Run to verify pass**: `pnpm -F bsv-tipping-demo test test/gate.test.ts` — Expected: PASS (5 run, 1 skipped). Then, locally, `pnpm -F bsv-tipping-demo gate init` prints an address (keep the key file; never paste it anywhere).

- [ ] **Step 5: Commit**

```bash
git add samples/tipping-shape-a .gitignore pnpm-lock.yaml
git commit -m "feat(sample): testnet gate script creating the CI wallet (address only), sweep and run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

HUMAN: Connor — run `pnpm -F bsv-tipping-demo gate init` on your machine, fund the printed address from `https://bsvfaucet.com` (sign in with a BSV wallet), run `pnpm -F bsv-tipping-demo gate sweep --txid <faucet txid>` once the faucet tx is visible, then `BSV_MCP_NETWORK_TESTS=1 pnpm -F bsv-tipping-demo gate run`. Add the key file's contents as the repo secret `BSV_TESTNET_GATE_KEY` (Settings → Secrets → Actions). Put the printed `probeTxid` into `content/versions.json#services.arcade.probeTxid` and run `pnpm sync`. None of this blocks Tasks 5–8.

---

### Task 5: Docker, compose, HOSTING.md, GUARDRAILS.md, TRUST.md, README, GHCR workflow

**Files:**
- Create: `samples/tipping-shape-a/Dockerfile`, `docker-compose.yml`, `HOSTING.md`, `GUARDRAILS.md`, `TRUST.md`, `.github/workflows/sample-ghcr.yml`
- Modify: `samples/tipping-shape-a/README.md`, `samples/README.md`, `env.example`
- Test: `samples/tipping-shape-a/test/docs.test.ts`

**Interfaces:**
- Consumes: `docs_url` ids `get-started.quick-start-browser`, `guides.payments`, `guides.wallet-aware-apps`, `guides.services.broadcasting` (plan 1a).
- Produces:
  - `Dockerfile` (context = repo root; `file: samples/tipping-shape-a/Dockerfile`): stage `build` from `node:22-alpine` with `corepack enable`, copy `pnpm-workspace.yaml`, `pnpm-lock.yaml`, root `package.json`, `samples/tipping-shape-a/package.json`; `pnpm install --frozen-lockfile --filter bsv-tipping-demo...`; copy the sample; `pnpm -F bsv-tipping-demo build`; `pnpm -F bsv-tipping-demo deploy --prod /out`; stage `runtime` from `node:22-alpine`: copy `/out`, `RUN node -e "require('better-sqlite3')"` (native addon check) and `RUN node --input-type=module -e "await import('./dist/server/app.js')"` (import smoke test, G-32), `USER node`, `VOLUME /data`, `ENV DATA_DIR=/data PORT=8080 BSV_NETWORK=testnet`, `EXPOSE 8080`, `HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/health || exit 1`, `RUN apk add --no-cache bash wget` in the runtime stage, `CMD ["bash", "-c", "bash scripts/network-guard.sh && node dist/server/index.js"]`. No key, no `.env` copied (`.dockerignore` excludes `.env`, `data/`, `node_modules`).
  - `docker-compose.yml`: service `tipping` from `ghcr.io/bsv-blockchain/bsv-tipping-demo:latest`, `ports: ["8080:8080"]`, `env_file: .env`, `volumes: ["tipping-data:/data"]`, `restart: unless-stopped`; named volume.
  - `HOSTING.md` headings: `## Image` (name, tags), `## Run` (compose snippet; port 8080), `## Environment` (`BSV_NETWORK=testnet`, `ARCADE_URL` optional, `PUBLIC_ORIGIN=https://<host>` required, `CREATOR_IDENTITY_KEY` optional), `## Persistence` (one volume at `/data`), `## Reverse proxy requirements` (HTTPS required because wallets need a secure originator; do not buffer `/api/events`: `proxy_buffering off` / `X-Accel-Buffering: no` honoured; pass `/manifest.json` through untouched with `application/manifest+json`, `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`), `## Health` (`GET /health`), `## Secrets` (none: no key or coin lives on the server), `## Network switch` (`BSV_NETWORK=mainnet` is the only change; the banner at boot).
  - `GUARDRAILS.md`: a table `| id | how this app satisfies it | file |` for G-01, G-02, G-03, G-04, G-05, G-06, G-09, G-10, G-12, G-13, G-14, G-15, G-16, G-21, G-34 and a line that shape-B rules (G-17–G-19, G-23, G-24) and contract rules do not apply; ends with the command `pnpm guardrails` and the expected `0 errors`.
  - `TRUST.md` headings: `## Served-code trust` (whoever serves this JavaScript can sign under the grouped grant for the tips protocol; keep the allowance small), `## 0-conf stance` (a tip is received at `SEEN_ON_NETWORK`+ with no competitor; no confirmation waits), `## What the relay can and cannot do` (can: drop or delay a tip notice, see remittances; cannot: spend, redirect, or forge a tip; the tipper's wallet broadcast and the posted BEEF stand without the relay), `## Residual risks`.
  - `README.md` headings: what it demonstrates, run locally (`pnpm dev`, BSV Desktop on testnet, two browser profiles or two wallets), `## Trust model` (link TRUST.md), guardrails (link), gate (link to Task 4 commands), docs links (the four `docs_url` ids resolved at write time to `https://docs.bsvblockchain.org/docs/<path>` URLs, with the ids in a comment so the nightly link check and `docs_url` keep them current), hosting (link HOSTING.md).
  - `.github/workflows/sample-ghcr.yml`: plan 1a-compatible copy of the demos' `ghcr.yml` with `on.push.branches: [main]`, `paths: ['samples/tipping-shape-a/**', 'pnpm-lock.yaml', '.github/workflows/sample-ghcr.yml']`, `tags: ['v*']`, `env.IMAGE_NAME: bsv-blockchain/bsv-tipping-demo`, `permissions: contents: read, packages: write`, steps checkout → `docker/setup-qemu-action@v3` → `docker/setup-buildx-action@v3` → `docker/login-action@v3` (GITHUB_TOKEN) → `docker/metadata-action@v5` (tags `type=raw,value=latest,enable={{is_default_branch}}`, `type=sha`, `type=semver,pattern={{version}}`, `type=semver,pattern={{major}}.{{minor}}`) → `docker/build-push-action@v6` (`context: .`, `file: samples/tipping-shape-a/Dockerfile`, `platforms: linux/amd64,linux/arm64`, `push: true`, `cache-from/to: type=gha`).

- [ ] **Step 1: Write the failing tests**: `GUARDRAILS.md maps every static rule that applies to shape A` (ids listed above all present as `| G-xx |`); `TRUST.md has the three required sections`; `README has a Trust model section` (G-34); `HOSTING.md names the image, the volume and the SSE no-buffer rule`; `Dockerfile has no .env, no key and runs as node` (`grep -c 'USER node'` = 1; no `COPY .env`; no `KEY=`); `env.example has no key variables`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Write the files**

- [ ] **Step 4: Verify**: `pnpm -F bsv-tipping-demo test`; `docker build -f samples/tipping-shape-a/Dockerfile -t bsv-tipping-demo:local .` succeeds and `docker run --rm -e PUBLIC_ORIGIN=http://localhost:8080 -p 8080:8080 bsv-tipping-demo:local` answers `curl -s localhost:8080/health` with `"ok":true` and `curl -sI localhost:8080/manifest.json` shows `application/manifest+json`; `bash scripts/anti-goals.sh samples/tipping-shape-a` exit 0.

- [ ] **Step 5: Commit**

```bash
git add samples .github/workflows/sample-ghcr.yml
git commit -m "feat(sample): Dockerfile, compose, HOSTING/GUARDRAILS/TRUST docs, GHCR workflow for bsv-tipping-demo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

HUMAN: Connor — hand `samples/tipping-shape-a/HOSTING.md` to the hosting team; they deploy `ghcr.io/bsv-blockchain/bsv-tipping-demo` on a `*.bsvb.tech` domain and tell you the origin. If they prefer a mirror repo under `bsv-blockchain-demos`, the folder is copied unchanged (its only dependencies are npm packages).

---

### Task 6: CI job `sample` and nightly job `gate`

**Files:**
- Modify: `.github/workflows/ci.yml` (add job `sample`), `.github/workflows/nightly.yml` (add job `gate`), `packages/mcp/test/fixtures/projects/` (none; the sample is linted in place)

**Interfaces:**
- Consumes: plan 1a job names; `BSV_TESTNET_GATE_KEY` secret; plan 1a CLI `packages/mcp/build/cli/check-guardrails.js` (Task 1).
- Produces: `ci.yml` job `sample` (needs `build-test`): `pnpm install --frozen-lockfile`, `pnpm -F @bsv/mcp build`, `pnpm -F bsv-tipping-demo build`, `pnpm -F bsv-tipping-demo test`, `pnpm -F bsv-tipping-demo guardrails` (fails on any error finding), `docker build -f samples/tipping-shape-a/Dockerfile .` (amd64 only, no push). `nightly.yml` job `gate` (`if: ${{ secrets.BSV_TESTNET_GATE_KEY != '' }}` is not valid YAML for secrets; use a first step that sets an output `has_key` from `${{ secrets.BSV_TESTNET_GATE_KEY != '' }}` and gate the remaining steps on it): `BSV_MCP_NETWORK_TESTS=1 BSV_NETWORK=testnet pnpm -F bsv-tipping-demo gate run`, uploads `docs/evals/gate-*.md` as an artifact (not committed by CI), and on failure appends a `## Gate` section to the freshness issue body (reuse plan 1a's issue step).

- [ ] **Step 1: Make the edits**

- [ ] **Step 2: Verify**: `npx -y action-validator .github/workflows/ci.yml .github/workflows/nightly.yml` (or `actionlint`) reports no errors; `grep -n 'BSV_TESTNET_GATE_KEY' .github/workflows/nightly.yml` shows it only in `secrets.` references, never echoed.

- [ ] **Step 3: Commit**

```bash
git add .github
git commit -m "ci: sample job (build, test, guardrails, docker build); nightly gate when the key secret exists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: WriteChoice hand-off: `briefing.md` and `coding-with-agents.md`

**Files:**
- Create: `docs/writechoice/briefing.md`, `docs/writechoice/coding-with-agents.md`, `community-skills.yaml` (repo root; empty list with a schema comment)
- Test: `packages/sync/test/writechoice.test.ts`

**Interfaces:**
- Consumes: install strings (plan 1b Global Constraints); `docs-index.yaml` ids; the sample's hosted origin (unknown: placeholder `https://tipping.bsvb.tech` marked `TODO(hosting)`).
- Produces:
  `briefing.md` headings (spec §10): `## What this project ships and owns` (`@bsv/mcp` 2.0.0, `bsv-dev-skill` 0.1.0, samples, `content/` as the single source; WriteChoice owns the site, `llms.txt` and the docs MCP), `## The three install commands` (exact strings), `## Host move request` (final URL, redirect map; today `https://docs.bsvblockchain.org/mcp` is 404 while `https://bsv.writedocs.io/mcp` is live; both hosts serve `/docs/<path>.md` (verified 2026-10-22); `docs_url` falls through hosts by id), `## Samples for /docs/showcase` (tipping-shape-a with its origin placeholder; later samples listed), `## Stubs this kit depends on` (`get-started/quick-start-server`, `guides/services/broadcasting`, `guides/go-to-mainnet`, `reference/networks`, `wallets/bsv-desktop`, `sdk/defaults`, `build-with-ai/skill` (today a "Page Not Found" body behind HTTP 200)), `## Docs samples that violate the guardrails` (the WoC custom-broadcaster example, the event-tickets tutorial, the `/reference/arc/*` block presented as current; each with the guardrail id), `## Replace the six-rule CLAUDE.md block on /llm-resources` (with `assets/CLAUDE.md.snippet`, quoted in full), `## Open questions for WriteChoice` (final host, redirect map, whether to host `@bsv/mcp` over HTTP in phase 3, community skills policy).
  `coding-with-agents.md` (frontmatter `title: Coding with agents`, `description:`): `## Why agents and BSV` (testnet-safe by default, wallet approvals in BSV Desktop, no keys in code), `## 1. Add the docs MCP` (`claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp`; Codex `codex mcp add bsv-docs --url https://bsv.writedocs.io/mcp` marked "verify"; Cursor/Windsurf/VS Code JSON), `## 2. Install the BSV skill` (`npx skills add bsv-blockchain/bsv-mcp`; `claude plugin marketplace add bsv-blockchain/bsv-mcp && claude plugin install bsv-dev@bsv`; note that the plugin bundles both MCPs), `## 3. Add @bsv/mcp for live tools` (`claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp`; what the tools do), `## Example prompts` (link `build-with-ai/prompts`; three prompts incl. "add tipping to my React app on BSV"), `## What goes where` (docs = prose, skill = judgment, MCP = actions), `## Safety` (testnet, approvals, no keys, `BSV_MCP_ALLOW_MAINNET_BROADCAST` explained), `## Skills library` (official + community; submission via PR adding to `community-skills.yaml` with commit-pinned links).
  `community-skills.yaml`: `# { name, repo, commit, description, maintainer }` comment and `skills: []`.

- [ ] **Step 1: Write the failing test**: `writechoice pages carry the install names and the three commands` (both files contain `bsv-docs`, `bsv-mcp`, `npx skills add bsv-blockchain/bsv-mcp`, `claude plugin install bsv-dev@bsv`); `briefing lists the required stubs and the violating samples`; `anti-goals.sh passes on docs/writechoice`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Write the files**

- [ ] **Step 4: Run to verify pass** — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/writechoice community-skills.yaml packages/sync/test/writechoice.test.ts
git commit -m "docs: WriteChoice briefing and draft coding-with-agents page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Phase-1 exit checklist and the `docs/evals/` protocol

**Files:**
- Create: `docs/evals/README.md`, `docs/evals/phase-1-exit-checklist.md`, `docs/evals/starter-app.md`, `docs/evals/TEMPLATE-run.md`
- Modify: root `README.md` (link the checklist under `## Release`), `CHANGELOG.md`

**Interfaces:**
- Produces:
  `docs/evals/README.md`: the fresh-agent protocol: three separate fresh Claude Code sessions, each in a new directory created per `starter-app.md` (`npm create vite@latest starter -- --template react-ts`, `npm i @bsv/sdk@3.2.1`), with only the skill and the docs MCP installed (`npx skills add bsv-blockchain/bsv-mcp`; `claude mcp add --transport http bsv-docs https://bsv.writedocs.io/mcp`; `@bsv/mcp` NOT installed in the session), prompt verbatim `add tipping to my React app on BSV`, no steering beyond answering the agent's questions with the facts in `starter-app.md` (creator identity key placeholder, testnet); afterwards run `node <repo>/packages/mcp/build/cli/check-guardrails.js <starter>` and record errors/warnings; a run passes with zero `error` findings; transcripts saved as `docs/evals/2026-MM-DD-run-N.md` from `TEMPLATE-run.md` (prompt, agent version, skill version, commands the agent ran, guardrail report JSON, pass/fail, notes); private keys or wallet details are never pasted.
  `phase-1-exit-checklist.md`: a checkbox list, each with owner and evidence column: (1) `npx skills add bsv-blockchain/bsv-mcp` works on a clean machine — HUMAN: Connor; (2) `claude plugin marketplace add bsv-blockchain/bsv-mcp && claude plugin install bsv-dev@bsv` works — HUMAN: Connor; (3) `@bsv/mcp@2.0.0` on npm with provenance (`npm view @bsv/mcp@2.0.0 dist.attestations`) — HUMAN: Deggen (trusted publisher) then Connor tags `v2.0.0`; (4) `check_guardrails` on `samples/tipping-shape-a` reports 0 errors — CI job `sample`; (5) the broken copy reports each of ARC class, `isAuthenticated`, mainnet default, WoC ancestry loop, missing manifest — CI (`packages/mcp/test/rules-broadcast.test.ts` `exit-criterion set is all errors`); (6) three fresh-agent runs pass with zero errors, transcripts in `docs/evals/` — HUMAN: Connor; (7) a real BSV Desktop tip on testnet lands in the creator's wallet at 0-conf on the hosted origin — HUMAN: Connor (steps: open the hosted `/creator` with the creator wallet, open `/` with a second BSV Desktop profile on testnet, tip 1000 sats, approve in BSV Desktop, observe "received" within seconds and the sats in the creator wallet without waiting for a block; record txid and timings); (8) gate run recorded and `probeTxid` set — HUMAN: Connor (Task 4); (9) `@bsv/simple-mcp` 0.0.3 published and deprecated — HUMAN: simple-mcp owner; (10) briefing delivered to WriteChoice — HUMAN: Connor.

- [ ] **Step 1: Write the four files; update README and CHANGELOG**

- [ ] **Step 2: Verify**: `bash scripts/anti-goals.sh docs/evals` exit 0; `pnpm test` all green; `pnpm sync:check` exit 0; `git status` clean after commit.

- [ ] **Step 3: Commit**

```bash
git add docs/evals README.md CHANGELOG.md
git commit -m "docs: phase-1 exit checklist and fresh-agent eval protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

HUMAN: Connor — items 1, 2, 6, 7, 8, 10 of the checklist are yours; items 3 and 9 need Deggen and the simple-mcp owner. The branch is complete for review once Tasks 1–8 here and all of plans 1a and 1b are committed.

---

## Self-review notes (applied)

- Spec coverage: §8.1 flow (Tasks 1–3: G-01/02/03/04/05 in `wallet.ts` and the manifest, G-09/13 in the relay, G-10 in `verdictOf`, G-16/21 in `collect.ts`, retries 10/30/60 s, SSE, SQLite idempotency, `GUARDRAILS.md`, `TRUST.md`, `env.example`, network-guard at boot, `docs_url`-resolved links in README); §8.1 hosting (Task 5: one container, one origin, Dockerfile, compose, HOSTING.md with every listed requirement, GHCR workflow modelled on headline-anchor's `ghcr.yml`, image name); §9 CI wallet (Task 4: deterministic root key outside the repo, only the address printed, spend path via `Setup.fundWalletFromP2PKHOutpoints` before any funding, `BSV_TESTNET_GATE_KEY`, nightly use in Task 6); §10 (Task 7); §11 exit (Task 8 + CI pins).
- Spec gaps noted for Connor: the creator identity for the hosted demo (env `CREATOR_IDENTITY_KEY` vs first-claim; the plan does both, Connor may prefer one); the hosted origin is unknown until the hosting team deploys (`TODO(hosting)` placeholder in the briefing).
- Unverified: `pnpm deploy --filter` behaviour under pnpm 10 inside Docker (Task 5 step 4 builds the image to prove it; fall back to copying `node_modules` from the build stage if `deploy` misbehaves); WoC `/tx/{txid}/proof/tsc` shape for building the sweep BEEF (the `sweep` subcommand is HUMAN-exercised; if the proof path fails, the fallback is to pay the gate wallet's BRC-29 address from BSV Desktop instead of the faucet, which `internalizeAction` handles without a proof); Codex `mcp add` syntax.

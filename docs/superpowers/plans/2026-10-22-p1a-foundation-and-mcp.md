# BSV AI DevKit phase 1a: Foundation and `@bsv/mcp` 2.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `bsv-blockchain/bsv-mcp` into a pnpm monorepo whose single `content/` tree feeds a rebuilt `@bsv/mcp` 2.0.0 (Arcade tools, `check_guardrails` with every static rule, fixed `brc_lookup`, `versions_check`, `docs_url`, resources, prompts), with CI, nightly freshness, tag-only release, and the `@bsv/simple-mcp` deprecation prepared.

**Architecture:** `content/` holds facts (Markdown with `verified:` dates), `versions.json`, `guardrails.yaml`, `docs-index.yaml`, `custody-shapes.md`, `threat-model.md`, `simple/*.md`; `packages/sync` renders it into `packages/mcp/content/` (committed, served as `bsv://` resources) and into the skill's generated references (plan 1b consumes them). `packages/mcp` is the MCP server: `config.ts` (env), `arcade/client.ts` (fetch with timeouts and status classification), `lint/` (walker + one rule file per static guardrail), `tools/`, `resources/`, `prompts/`. Unit tests mock `fetch` against recorded Arcade fixtures; network tests are opt-in.

**Tech Stack:** Node ≥ 22, TypeScript ≥ 5.8 (NodeNext ESM), pnpm 10 workspaces, `@modelcontextprotocol/sdk` 1.32.1 (`McpServer.registerTool/registerResource/registerPrompt`, `ResourceTemplate` from `@modelcontextprotocol/sdk/server/mcp.js`, raw zod shapes for `inputSchema`/`argsSchema`), `zod` ^3.25 (SDK 1.32 imports `zod/v4` internally; ^3.25 ships that subpath), `yaml` ^2.9, `ignore` ^7, `fast-glob` ^3.3, `vitest` ^4, `@bsv/sdk` 3.2.1 (for `Transaction.fromHexEF`, `Beef` and BEEF magic detection in tests), GitHub Actions, npm trusted publishing (OIDC).

**Spec:** `docs/superpowers/specs/2026-10-22-bsv-ai-devkit-design.md` (sections §3–§5, §7, §9, §12). Source lessons (LOCAL, never committed): the playbook (§2, §3, §4, §6, §7) and the handoff ("Rules the MCP should encode", "Reference facts"). Content written into the repo must stand alone: no paths or names from the earlier apps, no quoted chat, no local paths.

## Global Constraints

- Branch `feat/bsv-ai-devkit-p1` off `main`; every task ends with a commit whose message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Public repo, MIT. No code from the earlier apps. The two lessons write-ups are read, never copied or committed; no sentence written into the repo may mention them or any private chat.
- Never put a private key, WIF, seed phrase, or funded key in the repo, tests, fixtures, or logs. Tests that touch the network run only when `BSV_MCP_NETWORK_TESTS=1`; all other tests mock `globalThis.fetch`.
- Node ≥ 22 (`engines.node ">=22"` in every package), TypeScript ≥ 5.8, `"type": "module"`, pnpm workspaces (`packages/*`, `samples/*`). `package-lock.json` is deleted; `pnpm-lock.yaml` is committed.
- npm name `@bsv/mcp`, version `2.0.0`, bin `bsv-mcp`; the MCP server reports `name: "@bsv/mcp"` and the version read from its own `package.json` (never hardcoded).
- Environment variables (exact names): `BSV_NETWORK` (`testnet` default | `mainnet`), `ARCADE_URL`, `BSV_MCP_ALLOW_MAINNET_BROADCAST` (`1` enables `arcade_submit` on mainnet), `BSV_REPOS_DIR` (optional), `WOC_API_KEY` (optional, only `versions_check` may use it), `BSV_MCP_NETWORK_TESTS` (`1` enables network tests).
- Arcade defaults: testnet `https://arcade-testnet-us-1.bsvblockchain.tech`, mainnet `https://arcade-us-1.bsvblockchain.tech`. Known mainnet hosts: `arcade-us-1`, `arcade-eu-1`, `arcade-ap-1`, `arcade-v2-us-1` (all `.bsvblockchain.tech`), `arcade.gorillapool.io`. Known testnet hosts: `arcade-testnet-us-1`, `arcade-v2-testnet-us-1`. `arcade-v2-ttn-us-1` is neither (Teranode test network): accepted only as an explicit `arcadeUrl`, with a warning.
- A transaction is final for an app at `SEEN_ON_NETWORK` or later with no competing tx; the kit never waits for `MINED`. Never ARC (`/v1/tx`, SDK `ARC` class), never WhatsOnChain as truth for a known txid. These are tested by the anti-goal grep in CI (Task 16).
- Every fact and every resource body carries `verified: YYYY-MM-DD`; the content lint fails otherwise. Today is `2026-10-22`; every fact in this plan is dated `2026-10-22`.
- Guardrail ids are `G-01`..`G-34` exactly as in spec §7 (two digits, zero-padded). Suppression comment: `// bsv-guardrail-ignore G-xx reason` (also `#`, `<!--`, `/*` comment forms) on the flagged line or the line above.
- The MCP never edits user files; `check_guardrails` is read-only.
- Workflows: `ci.yml`, `nightly.yml`, `release.yml` only; `push.yaml` and `npm-publish.yml` are deleted in the same commit that adds them. No long-lived npm token anywhere. The nightly job may open or update exactly one issue titled `Freshness: content drift`.

## Review Focus

1. `arcade_submit` given a BEEF or AtomicBEEF hex (prefix `0100beef`, `0200beef`, `01010101`): must refuse before any network call with a message telling the caller to convert to EF or raw (Task 7 test `refuses BEEF before contacting Arcade`).
2. `arcade_status` on an instance that never saw the txid (404): must return `verdict: 'no-verdict'`, never throw, never say "rejected" (Task 7 test `404 is no-verdict`).
3. `check_guardrails` on a project whose only broadcast code is inside a `// bsv-guardrail-ignore G-09 ...` line: must list G-09 in `passed`, not `findings` (Task 8 test `ignore comment suppresses a finding`).
4. `docs_url` when a host answers HTTP 200 with a "Page Not Found" body (verified today on `docs.bsvblockchain.org`): must treat it as a miss and fall through to the next host (Task 12 test `soft 404 is a miss`).
5. `arcade_submit` with `ARCADE_URL=http://localhost:8080` and `BSV_NETWORK=testnet`: the host cross-check must not reject a localhost or unknown host (Task 5 test `unknown host passes the cross-check`).

---

## Cross-plan interfaces (defined here, used verbatim by plans 1b and 1c)

**Content schema (`content/`)**
- `content/facts/<name>.md` starts with a YAML frontmatter block containing at least `verified: YYYY-MM-DD` and `title:`; each table row or bullet that states a measured/observed value carries its date in parentheses when it differs from the file's `verified` date.
- `content/versions.json`:
  ```json
  {
    "verified": "2026-10-22",
    "packages": { "<npm name>": { "pinned": "x.y.z", "verified": "YYYY-MM-DD", "note": "optional" } },
    "git": { "runar": { "repo": "icellan/runar", "branch": "main", "commit": "d207ee8", "version": "1.0.0-rc.1", "verified": "2026-10-22", "npmVersion": "0.4.6", "npmUnsafe": true } },
    "services": { "arcade": { "version": "v0.16.0", "verified": "2026-10-22", "hosts": { "testnet": ["https://arcade-testnet-us-1.bsvblockchain.tech", "https://arcade-v2-testnet-us-1.bsvblockchain.tech"], "mainnet": ["https://arcade-us-1.bsvblockchain.tech", "https://arcade-eu-1.bsvblockchain.tech", "https://arcade-ap-1.bsvblockchain.tech", "https://arcade-v2-us-1.bsvblockchain.tech"], "ttn": ["https://arcade-v2-ttn-us-1.bsvblockchain.tech"] }, "probeTxid": "" } },
    "runtime": { "node": ">=22", "typescript": ">=5.8", "pnpm": ">=10" }
  }
  ```
  `packages` keys: `@bsv/sdk` 3.2.1, `@bsv/wallet-toolbox` 2.14.9, `@bsv/simple` 0.7.0, `@bsv/auth-express-middleware` 2.2.9, `@modelcontextprotocol/sdk` 1.32.1, `skills-ref` 0.1.5, `runar-sdk` 0.4.6 (`note: "npm is stale and unsafe; use git.runar"`). `services.arcade.probeTxid` is filled by plan 1c's gate run; empty means "probe skipped".
- `content/guardrails.yaml`: a top-level list; each item `{ id: "G-01", title, shape: "A"|"B"|"both", rule, why, detect: "static"|"manual"|"contract", severity: "error"|"warn", refs: ["docs:<docs-index id>" | "brc:<n>" | "fact:<facts file name>"] }`. `severity` is a plan addition (findings need one): errors G-01, G-02, G-03, G-06, G-09, G-10, G-12, G-16, G-21, G-25; warns G-04, G-14, G-15, G-31, G-34; manual/contract rules carry `severity: "warn"`.
- `content/docs-index.yaml`: `{ hosts: ["https://bsv.writedocs.io/docs/", "https://docs.bsvblockchain.org/docs/"], ids: { "<id>": { path: "guides/payments", title: "...", legacy?: "https://..." } } }`. Both hosts serve `<host><path>.md` (verified 2026-10-22; the spec's `bsv.writedocs.io/<path>.md` form is wrong by the `docs/` segment, so `hosts` carry it).
- `content/brc-categories.json`: `{ "verified": "2026-10-22", "categories": ["apps","key-derivation","opinions","outpoints","overlays","payments","peer-to-peer","scripts","state-machines","tokens","transactions","wallet"], "index": { "0029": "payments", "0073": "wallet", "0100": "wallet" } }` (the nightly regenerates `index` from the BRCs README).
- `content/custody-shapes.md`, `content/threat-model.md`, `content/simple/{api,gotchas}.md`: Markdown with the same frontmatter rule.

**Sync outputs (`pnpm sync`, Task 4)**
- `packages/mcp/content/**`: verbatim copy of `content/` plus `guardrails.json` (the YAML list as JSON) and `docs-index.json`.
- `packages/skill/skills/bsv-dev/references/facts.md` (all `content/facts/*.md` concatenated, each under `## <title>`), `references/guardrails.md` (one `### G-xx <title>` section per rule with rule/why/detect/shape/refs), `references/stack.md` (from `versions.json`), `references/custody-shapes.md` and `references/threat-model.md` (copies). Each starts with `<!-- generated by packages/sync from @bsv/mcp content v<version>; do not edit; verified dates inside -->`.
- `pnpm sync --check` exits 1 and prints the differing paths when any output would change.

**MCP tool names and types (`packages/mcp/src/types.ts`, Task 5)**
```ts
export type Network = 'testnet' | 'mainnet'
export type TxStatus = 'UNKNOWN'|'RECEIVED'|'SENT_TO_NETWORK'|'ACCEPTED_BY_NETWORK'|'SEEN_ON_NETWORK'|'SEEN_MULTIPLE_NODES'|'DOUBLE_SPEND_ATTEMPTED'|'REJECTED'|'PENDING_RETRY'|'STUMP_PROCESSING'|'MINED'|'IMMUTABLE'
export interface TransactionStatus { txid: string; txStatus: TxStatus; timestamp: string; status?: number; blockHash?: string; blockHeight?: number; merklePath?: string | null; extraInfo?: string; competingTxs?: string[]; rawTx?: string; retryCount?: number; nextRetryAt?: string }
export type Verdict = 'seen-no-competitor' | 'on-network-not-seen' | 'pending' | 'terminal' | 'no-verdict'
export interface SubmitResult { txid: string; postStatus: number; txStatus: TxStatus | 'UNREACHABLE'; verdict: Verdict; competingTxs: string[]; extraInfo?: string; arcCode?: number; transient: boolean; warning?: string }
export interface StatusResult extends TransactionStatus { verdict: Verdict; isFinalForApp: boolean; rawTxPresent: boolean; rawTxFormat?: 'ef' | 'raw'; note?: string }
export type Severity = 'error' | 'warn'
export interface Finding { id: string; severity: Severity; file: string; line: number; snippet: string; fix: string; ref: string }
export type ShapeDetected = 'A' | 'B' | 'A+B' | 'unknown'
export interface GuardrailReport { shapeDetected: ShapeDetected; findings: Finding[]; passed: string[]; notApplicable: string[]; manualChecklist: string[] }
export interface VersionRow { name: string; pinned: string; latest: string; verifiedOn: string; ageDays: number; drift: boolean; note?: string }
```
Tools: `arcade_submit`, `arcade_status`, `arcade_policy`, `arcade_health`, `check_guardrails`, `brc_lookup`, `versions_check`, `docs_url`, `code_search`, `find_function_definition`. Resources: `bsv://facts/{arcade,networks,whatsonchain,wallet-limits,consensus,fees,runar,tokens-1color,versions}`, `bsv://guardrails`, `bsv://custody-shapes`, `bsv://threat-model`, `bsv://docs/index`, `bsv://simple/api`, `bsv://simple/gotchas`, template `bsv://brc/{id}`. Prompts: `review_against_guardrails`, `tokenize_with_1color`, `integrate_simple`, `add_simple_feature`, `debug_simple`.

**CI job names** (Task 16): `ci.yml` jobs `build-test` and `content`; plan 1b adds job `skill`; plan 1c adds job `sample`. `nightly.yml` job `freshness`; plan 1c adds job `gate`. `release.yml` job `publish`; plan 1b adds the skill zip step to it.

**Deprecation materials** (Task 17): `docs/deprecation/simple-mcp/` holds everything the simple-mcp PR needs.

---

### Task 1: Branch, pnpm workspace, move the server to `packages/mcp`

**Files:**
- Create: `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/vitest.config.ts`, `.npmrc`, `.nvmrc`
- Modify: `package.json` (root becomes private workspace root), `.gitignore`
- Move: `src/index.ts` → `packages/mcp/src/index.ts` (`git mv`); delete `build/`, `package-lock.json`, `tsconfig.json`
- Test: `packages/mcp/test/smoke.test.ts`

**Interfaces:**
- Produces: workspace scripts at the root: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm sync`, `pnpm sync:check`, `pnpm check:facts`, `pnpm check:links` (the last four are wired in Task 4; declare them now as `pnpm -F @bsv/sync ...` passthroughs). `packages/mcp/package.json`: `name "@bsv/mcp"`, `version "2.0.0"`, `bin { "bsv-mcp": "build/index.js" }`, `files ["build", "content", "README.md", "LICENSE.md"]`, `repository.url "git+https://github.com/bsv-blockchain/bsv-mcp.git"` (must match the GitHub repo exactly for trusted publishing), `publishConfig { "access": "public" }`, `engines.node ">=22"`, `license "MIT"`, scripts `build: tsc -p tsconfig.json`, `test: vitest run`, `start: node build/index.js`.

- [ ] **Step 1: Create the branch**

Run: `git checkout -b feat/bsv-ai-devkit-p1`
Expected: `Switched to a new branch 'feat/bsv-ai-devkit-p1'`

- [ ] **Step 2: Write the failing smoke test**

```ts
// packages/mcp/test/smoke.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
describe('package', () => {
  it('is @bsv/mcp 2.0.0 with bin bsv-mcp', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.name).toBe('@bsv/mcp')
    expect(pkg.version).toBe('2.0.0')
    expect(pkg.bin['bsv-mcp']).toBe('build/index.js')
    expect(pkg.engines.node).toBe('>=22')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/mcp && npx vitest run test/smoke.test.ts`
Expected: FAIL (no vitest / no package.json at that path)

- [ ] **Step 4: Create the workspace files and move the source**

`pnpm-workspace.yaml`: `packages: ["packages/*", "samples/*"]`. Root `package.json`: `"name": "bsv-ai-devkit"`, `"private": true`, `"packageManager": "pnpm@10.x"` (the installed pnpm's exact version), `"engines": {"node": ">=22"}`, scripts listed in Interfaces, devDependencies `typescript ^5.8`, `vitest ^4`, `@types/node ^22`. `tsconfig.base.json`: `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict`, `skipLibCheck`, `esModuleInterop`, `declaration false`. `packages/mcp/tsconfig.json` extends it with `rootDir src`, `outDir build`, `include ["src"]`. `.nvmrc`: `22`. `.npmrc`: `engine-strict=true`. `.gitignore`: add `build/`, `*.sqlite`, `samples/**/data/`, `.bsv-gate/`. `git mv src/index.ts packages/mcp/src/index.ts`; `git rm -r build tsconfig.json package-lock.json`. Dependencies of `packages/mcp`: `@modelcontextprotocol/sdk 1.32.1` (exact), `zod ^3.25.76`, `execa ^9`, `yaml ^2.9`, `ignore ^7`, `fast-glob ^3.3`; devDependency `@bsv/sdk 3.2.1` (fixtures only).

- [ ] **Step 5: Install and verify the build and test pass**

Run: `pnpm install && pnpm build && pnpm test`
Expected: `tsc` exits 0 (the moved `index.ts` still compiles unchanged); smoke test PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: pnpm workspace; move @bsv/mcp to packages/mcp at 2.0.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Machine-readable content: `guardrails.yaml`, `versions.json`, `docs-index.yaml`, `brc-categories.json`, and the content lint

**Files:**
- Create: `content/guardrails.yaml`, `content/versions.json`, `content/docs-index.yaml`, `content/brc-categories.json`, `packages/sync/package.json`, `packages/sync/tsconfig.json`, `packages/sync/src/schema.ts`, `packages/sync/src/lint.ts`, `packages/sync/src/cli.ts`
- Test: `packages/sync/test/lint.test.ts`

**Interfaces:**
- Produces: `packages/sync` (`name "@bsv/sync"`, private, bin none; scripts `sync`, `sync:check`, `check:facts`, `check:links` all via `node --import tsx src/cli.ts <cmd>`; devDependency `tsx`). `schema.ts` exports zod schemas `GuardrailSchema`, `GuardrailsFile`, `VersionsFile`, `DocsIndexFile`, `BrcCategoriesFile` matching the Cross-plan content schema. `lint.ts` exports `lintContent(contentDir: string): Promise<{ errors: string[] }>` checking: every `facts/*.md`, `custody-shapes.md`, `threat-model.md`, `simple/*.md` has frontmatter `verified: YYYY-MM-DD` and `title`; `guardrails.yaml` parses, has exactly ids `G-01`..`G-34` in order, every field present; every `versions.json` entry has `verified`; every `docs-index.yaml` id has `path` and `title`. `cli.ts` subcommands: `sync`, `sync --check`, `check:facts`, `check:links` (`check:links` and `sync` are implemented in Task 4; stub them to exit 2 "not implemented" now).

- [ ] **Step 1: Write the failing lint tests**

```ts
// packages/sync/test/lint.test.ts
import { describe, it, expect } from 'vitest'
import { lintContent } from '../src/lint.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = new URL('../../../content', import.meta.url).pathname
describe('lintContent', () => {
  it('passes on the repo content', async () => {
    expect((await lintContent(root)).errors).toEqual([])
  })
  it('fails a fact without verified', async () => {
    const d = mkdtempSync(join(tmpdir(), 'c-')); mkdirSync(join(d, 'facts'))
    writeFileSync(join(d, 'facts', 'x.md'), '---\ntitle: X\n---\nbody\n')
    const { errors } = await lintContent(d)
    expect(errors.some(e => e.includes('facts/x.md') && e.includes('verified'))).toBe(true)
  })
  it('requires G-01..G-34 in order', async () => {
    const d = mkdtempSync(join(tmpdir(), 'c-'))
    writeFileSync(join(d, 'guardrails.yaml'), '- id: G-02\n  title: t\n  shape: both\n  rule: r\n  why: w\n  detect: manual\n  severity: warn\n  refs: []\n')
    const { errors } = await lintContent(d)
    expect(errors.some(e => e.includes('G-01'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @bsv/sync test`
Expected: FAIL (module not found)

- [ ] **Step 3: Write `content/guardrails.yaml`**

34 entries, one per spec §7 bullet, fields per the Cross-plan schema. `rule` and `why` are the spec's sentences; `shape`, `detect` as given; `severity` per the schema note; `refs`: G-01/03/04/05 `["docs:guides.wallet-aware-apps","brc:73","brc:100"]`; G-09/10/11/13/14/15/16 `["docs:guides.services.broadcasting","fact:arcade"]`; G-12 `["fact:whatsonchain","fact:arcade"]`; G-21 `["brc:29","docs:guides.payments"]`; G-25/26/27/28/29 `["fact:runar","fact:consensus"]`; G-02/G-31 `["fact:networks","fact:versions"]`; the rest `[]`.

- [ ] **Step 4: Write `content/versions.json`, `content/docs-index.yaml`, `content/brc-categories.json`**

Values exactly as in the Cross-plan interfaces. `docs-index.yaml` ids (all paths verified 2026-10-22 against `https://docs.bsvblockchain.org/llms.txt`): `get-started.quick-start-browser` → `get-started/quick-start-browser`; `get-started.quick-start-server` → `get-started/quick-start-server`; `get-started.project-starter` → `get-started/project-starter`; `build-with-ai` → `build-with-ai`; `build-with-ai.prompts` → `build-with-ai/prompts`; `build-with-ai.llm-resources` → `build-with-ai/llm-resources`; `build-with-ai.skill` → `build-with-ai/skill` (stub today); `guides.payments` → `guides/payments`; `guides.identity-auth` → `guides/identity-auth`; `guides.app-frameworks` → `guides/app-frameworks`; `guides.wallet-aware-apps` → `guides/wallet-aware-apps`; `guides.go-to-mainnet` → `guides/go-to-mainnet`; `guides.services.broadcasting` → `guides/services/broadcasting` with `legacy: https://docs.bsvblockchain.org/broadcasting/arcade`; `guides.services.local-stack` → `guides/services/local-stack`; `reference.wallet-api` → `reference/wallet-api`; `reference.networks` → `reference/networks` (stub, listed in the spec's briefing); `wallets.bsv-desktop` → `wallets/bsv-desktop`.

- [ ] **Step 5: Implement `schema.ts`, `lint.ts`, `cli.ts`**

`lintContent` walks the directory with `fast-glob`, parses frontmatter with a 20-line regex (`^---\n([\s\S]*?)\n---`) + `yaml`. The ordering check compares `ids` to `Array.from({length:34},(_,i)=>'G-'+String(i+1).padStart(2,'0'))`.

- [ ] **Step 6: Run the tests**

Run: `pnpm -F @bsv/sync test`
Expected: PASS (3 tests). Note: `passes on the repo content` passes now only because no `facts/*.md` exist yet; Task 3 adds them.

- [ ] **Step 7: Commit**

```bash
git add content packages/sync package.json pnpm-lock.yaml
git commit -m "feat(content): guardrails.yaml G-01..G-34, versions.json, docs-index.yaml, content lint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Authored content: facts, custody shapes, threat model, simple notes

**Files:**
- Create: `content/facts/{arcade,networks,whatsonchain,wallet-limits,consensus,fees,runar,tokens-1color,versions}.md`, `content/custody-shapes.md`, `content/threat-model.md`, `content/simple/api.md`, `content/simple/gotchas.md`
- Test: `packages/sync/test/lint.test.ts` (existing `passes on the repo content`)

**Interfaces:**
- Produces: the nine fact files and four judgment files consumed by Task 4 (sync), Task 13 (resources) and plan 1b (references). Read before writing: playbook §2, §3.3, §6.1–§6.7, §4.6, §4.12; handoff "Reference facts". Write facts in your own words; no source citations to private files.

- [ ] **Step 1: Write the nine fact files** (frontmatter `title`, `verified: 2026-10-22`, `source: @bsv/mcp content`; required headings and facts):

`arcade.md`: `## Endpoints` (`POST /tx` content types `text/plain` hex, `application/octet-stream`, `application/json {rawTx}`; raw or EF; BEEF rejected; `GET /tx/{txid}`; `GET /policy`; `GET /health`; `GET /events?callbackToken=` SSE on the standalone sse service; headers `X-CallbackUrl`, `X-CallbackToken`, `X-FullStatusUpdates`). `## Status lifecycle` (the 12 `txStatus` values; `SEEN_ON_NETWORK` = 0-conf safe; `REJECTED`/`DOUBLE_SPEND_ATTEMPTED` terminal; `UNKNOWN`/`PENDING_RETRY` non-final). `## Response shapes` (202 `{txid,status,txStatus}`; 400 `{error,reason?,txid?,status?,title?,detail?,type?}`; `TransactionStatus` fields incl. `extraInfo`, `competingTxs` (omitted when none), `rawTx` (documented "only while PENDING_RETRY", observed on MINED on testnet 2026-10-22; Extended Format), `status` numeric ARC code 460–476). `## ARC codes` (460 not EF, 461 malformed, 465 fee too low, 466 UTXO_SPENT, 476 not final). `## Policy` (testnet `/policy` 2026-10-22: miningFee 1 sat/1000 bytes, maxtxsizepolicy 100000000, maxscriptsizepolicy 100000000; mainnet datahubs report 100 sat/kB). `## Observed timing` (status readable 0.5–2 s after POST; SEEN_ON_NETWORK in 3–10 s; rejection can land ~20 ms after a 2xx; 404 = instance never saw it). `## Version` (public instances v0.16.0, OpenAPI info.version 1.0.0).

`networks.md`: table per network (testnet, mainnet): Arcade default host + alternates (from `versions.json`), WoC base `https://api.whatsonchain.com/v1/bsv/{test|main}`, explorer `https://test.whatsonchain.com` / `https://whatsonchain.com`, faucet `https://bsvfaucet.com` (sign in with a BSV wallet, up to 10M sats, 24 h cooldown) / "buy BSV", fee reality (1 sat/kB min testnet; 100 sat/kB mainnet datahubs), BSV Desktop ports HTTP 3321 / HTTPS 2121, `getNetwork()` values `'testnet'|'mainnet'`, wallet-toolbox `Chain` values `'test'|'main'`. A `## ttn` note: `arcade-v2-ttn-us-1` is a Teranode test network, neither testnet nor mainnet.

`whatsonchain.md`: allowed endpoints (`/address/{a}/unspent`, `/tx/{txid}/{vout}/spent`, `/chain/info`, `/tx/{txid}/proof/tsc`, `/tx/{txid}/hex` only for a tx Arcade never saw), free tier ≈3 req/s per IP → 429, one process-wide gate ≥350 ms, `WOC_API_KEY` as raw `Authorization` header, traps (hex 404 on fresh tx = "not yet"; unspent listings keep coins spent by unconfirmed txs; verify returned hex hashes to the txid; 6–12 s spend-index lag).

`wallet-limits.md`: the SDK client-side result limits table (33-byte pubkey, DER ≤72, HMAC 32, encrypt/decrypt up to 256 MiB, protocolID `[0..2, 5–400 chars]`, keyID 1–800, `createSignature` exactly one of `data`/`hashToDirectlySign` (32-byte double-SHA256)); BRC-29 ids `[2,'3241645161d8']`, `keyID = prefix + ' ' + suffix`, sender derives with `counterparty = recipient`, recipient verifies with `forSelf: true`; manifest keys `metanet.groupPermissions` and `babbage.groupPermissions` (`spendingAuthorization {amount (monthly sats), description}`, `protocolPermissions [{protocolID, counterparty?, description}]`, `basketAccess [{basket, description}]`); permission levels 0/1/2 and prompt behaviour; `isAuthenticated()` throws on a locked wallet in SDK 3.2.1; BSV Desktop `express.json({limit:'50mb'})`; auth middleware ~100 k JSON nodes (use `beefHex` strings).

`consensus.md`: post-Genesis `nSequence` = finality flag only; no replacement; BIP68/CSV NOPs; no relative locktimes; `nLockTime < 500000000` = height else Unix time vs MTP (MTP lags ~1 h); Arcade rejects non-final txs with 476; no `OP_CHECKDATASIG`; Chronicle (mainnet height 943816, 2026-04-07) adds opcodes and a sighash flag, relaxes malleability for version >1; stay on version-1 + BIP-143; default policy `maxscriptsizepolicy` 500000, `maxtxsizepolicy` 10 MB, script numbers to 750000 bytes; txid covers unlocking scripts (last signer can mint twins).

`fees.md`: rates per network; measured sizes/costs table (P2PKH funding tx 225–965 B / 23–97 sats at 100 sat/kB; 10 KB covenant opening ≈1005–1034 sats; 29.4 KB stateful move ≈2945 sats; 19.6 KB close ≈1970 sats; tiny refund 191–328 B / 20–33 sats); dust 546 for wallet outputs; size fees from the serialized draft, never a guess.

`runar.md`: version state (npm `runar-sdk` 0.4.6 stale and forgeable `checkPreimage`; upstream `icellan/runar` main `d207ee8` 2026-09-18 = `1.0.0-rc.1`, no tags); rc.1 quirks (typed locals before arithmetic, no loops, stack cap 800, no `buildP2PKH`, fixed output sets per method, three script copies per state transition, `_changePKH/_changeAmount` unpinned unless a signature covers outputs); `runar-ir-schema` `fileURLToPath(import.meta.url)` crashes browsers → Vite aliases for `node:url/path/fs` + build check; build recipe (pnpm; clone main; build; pack; `pnpm.overrides`; add `fast-check`); slim artifact fields; `verifyRabinSig` equation note (`(sig² + padding) mod n == LE_uint256(SHA256(msg))`, modulus > 2^256).

`tokens-1color.md`: BRC-162 output layout summary, token id, deploy/mint/transfer/burn/authority semantics, DAG-CBOR payload, 1-sat convention; BRC-207 wallet flow (baskets `p color <assetTag>`, plan labels, `createSignature` envelope, overlay admission); implementation status 2026-10-22 (`@bsv/templates` 2.0 `Bsv21Binary`, `@bsv/overlay-topics` 2.0, BRC-207 only in `@bopen-io/*` interim forks, no `@bsv/wallet-toolbox` or BSV Desktop support); naming history (Mandala withdrawn); phase-1 scope = encoding guidance only.

`versions.md`: a table rendered from the same values as `versions.json` (name, pinned, verified, note) plus the Node/TS/pnpm floors.

- [ ] **Step 2: Write `content/custody-shapes.md`** with headings `## Shape A: user-side BRC-100 wallet` (identity, per-app keys, silent signing under BRC-73, settles without the server; cons: wallet install, level-2 per-peer prompts, served-code trust), `## Shape B: app-side server wallet` (`@bsv/wallet-toolbox`, `go-wallet-toolbox`, `@bsv/simple` ServerWallet; automation, 402 receipts, no user wallet; cons: operator custody, key/storage ops, fee budgets, bookkeeping), `## Decision questions` (five yes/no questions), `## Rules inside shape B` (bounded budgets, write-ahead records, never count client-reported txids, deterministic derivations, "fund the server" path, wallet-toolbox cannot spend externally received P2PKH → BRC-29 + `internalizeAction` or `Setup.fundWalletFromP2PKHOutpoints` from a root-key P2PKH), `## Both shapes may coexist`.

- [ ] **Step 3: Write `content/threat-model.md`** with headings `## 0-conf is safe` (first-seen, no replacement), `## Not modelled: miner collusion` (accepted residual risk, no machinery), `## Ordinary failures to handle` (drop/eviction → re-post; two-read dead rule: `REJECTED` or a foreign competitor on two reads ≥20 s apart; indexer lag; own conflicting broadcast), `## Served-code trust` (whoever serves the JavaScript can sign under a grouped grant; say so in every app), `## Wallet-side residuals`.

- [ ] **Step 4: Write `content/simple/api.md` and `content/simple/gotchas.md`** rewritten for `@bsv/simple` 0.7.0, testnet-first: `api.md` headings `## Wallet (browser/server)`, `## Payments and 402`, `## Tokens`, `## Inscriptions/data`, `## MessageBox`, `## Certificates/DID`, `## Overlay`, each a short API listing with the 0.7 method names (read from `npm view @bsv/simple@0.7.0 readme` and the package's `.d.ts`; do not copy simple-mcp text). `gotchas.md`: `network` defaults to `main` (always pass `testnet`); no `arcadeUrl` option (broadcast goes through its own path; drop to `@bsv/sdk` + Arcade when you need tracking); `pay()` via MessageBox may return an empty txid; `basket insertion` and `wallet payment` are mutually exclusive per output; server `authorize` callback; `acceptIncomingPayment` without basket uses `wallet payment`.

- [ ] **Step 5: Run the content lint**

Run: `pnpm -F @bsv/sync test && bash scripts/anti-goals.sh content`
Expected: tests PASS; last line `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add content
git commit -m "feat(content): facts, custody shapes, threat model, @bsv/simple notes (verified 2026-10-22)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `packages/sync`: render content, `--check`, link check

**Files:**
- Create: `packages/sync/src/render.ts`, `packages/sync/src/links.ts`
- Modify: `packages/sync/src/cli.ts`
- Create (generated, committed): `packages/mcp/content/**`, `packages/skill/skills/bsv-dev/references/{facts,guardrails,stack,custody-shapes,threat-model}.md`
- Test: `packages/sync/test/render.test.ts`

**Interfaces:**
- Produces: `renderAll(opts: { contentDir: string; mcpOut: string; skillRefsOut: string; version: string }): Promise<Map<string, string>>` (path → content, without writing); `writeOrCheck(files: Map<string,string>, check: boolean): Promise<string[]>` returns the differing paths; `checkLinks(contentDir: string, extraDirs: string[]): Promise<{ broken: {url: string; file: string; status: number}[] }>` (HEAD then GET, 10 s timeout, treats a body starting with `# Page Not Found` as broken). CLI: `sync`, `sync --check` (exit 1 on diff), `check:facts` (exit 1 on lint errors or on any `verified` older than 60 days when `--max-age-days 60` is passed), `check:links`.

- [ ] **Step 1: Write the failing render tests**

```ts
// packages/sync/test/render.test.ts
import { describe, it, expect } from 'vitest'
import { renderAll } from '../src/render.js'
const contentDir = new URL('../../../content', import.meta.url).pathname
describe('renderAll', () => {
  it('produces the mcp snapshot and the skill references', async () => {
    const out = await renderAll({ contentDir, mcpOut: 'packages/mcp/content', skillRefsOut: 'packages/skill/skills/bsv-dev/references', version: '2.0.0' })
    for (const p of ['packages/mcp/content/guardrails.json', 'packages/mcp/content/docs-index.json', 'packages/mcp/content/facts/arcade.md',
      'packages/skill/skills/bsv-dev/references/facts.md', 'packages/skill/skills/bsv-dev/references/guardrails.md', 'packages/skill/skills/bsv-dev/references/stack.md',
      'packages/skill/skills/bsv-dev/references/custody-shapes.md', 'packages/skill/skills/bsv-dev/references/threat-model.md']) expect(out.has(p), p).toBe(true)
  })
  it('renders one ### G-xx heading per guardrail', async () => {
    const out = await renderAll({ contentDir, mcpOut: 'm', skillRefsOut: 's', version: '2.0.0' })
    const g = out.get('s/guardrails.md')!
    expect(g.match(/^### G-\d\d /gm)).toHaveLength(34)
    expect(g.startsWith('<!-- generated by packages/sync from @bsv/mcp content v2.0.0')).toBe(true)
  })
  it('is deterministic', async () => {
    const a = await renderAll({ contentDir, mcpOut: 'm', skillRefsOut: 's', version: '2.0.0' })
    const b = await renderAll({ contentDir, mcpOut: 'm', skillRefsOut: 's', version: '2.0.0' })
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @bsv/sync test test/render.test.ts`
Expected: FAIL (`render.js` not found)

- [ ] **Step 3: Implement `render.ts`, `links.ts`, wire `cli.ts`**

`version` comes from `packages/mcp/package.json`. `stack.md` is a table `| package | pinned | verified | note |` plus git and services sections. No timestamps in output (determinism).

- [ ] **Step 4: Run sync, then the check, then tests**

Run: `pnpm sync && pnpm sync:check; echo exit=$? && pnpm -F @bsv/sync test`
Expected: `exit=0`; tests PASS. `git status` shows the generated files under `packages/mcp/content/` and `packages/skill/skills/bsv-dev/references/`.

- [ ] **Step 5: Verify `--check` detects drift**

Run: `echo x >> packages/mcp/content/facts/fees.md && pnpm sync:check; echo exit=$?; git checkout packages/mcp/content/facts/fees.md`
Expected: `exit=1` and the path printed.

- [ ] **Step 6: Commit**

```bash
git add packages/sync packages/mcp/content packages/skill package.json
git commit -m "feat(sync): render content to the MCP snapshot and skill references; --check; link check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `config.ts` and `types.ts`: environment, network resolution, host cross-check

**Files:**
- Create: `packages/mcp/src/config.ts`, `packages/mcp/src/types.ts`
- Test: `packages/mcp/test/config.test.ts`

**Interfaces:**
- Produces: `types.ts` exactly as in Cross-plan interfaces. `config.ts`:
  ```ts
  export const DEFAULT_ARCADE: Record<Network, string>
  export const KNOWN_HOSTS: { mainnet: string[]; testnet: string[]; ttn: string[] }   // hostnames
  export interface Config { network: Network; arcadeUrl: string; allowMainnetBroadcast: boolean; reposDir?: string; wocApiKey?: string; version: string }
  export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config   // throws on BSV_NETWORK not in {testnet, mainnet}
  export function resolveNetwork(input: { network?: Network; arcadeUrl?: string }, cfg: Config): { network: Network; arcadeUrl: string; warning?: string }
  // throws Error('network/host mismatch: ...') when arcadeUrl host is in KNOWN_HOSTS of the other network;
  // returns warning 'ttn host: neither testnet nor mainnet' for a ttn host; unknown hosts (localhost, custom) pass.
  export function readPackageVersion(): string   // from packages/mcp/package.json relative to build/
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/mcp/test/config.test.ts
import { describe, it, expect } from 'vitest'
import { loadConfig, resolveNetwork } from '../src/config.js'
describe('loadConfig', () => {
  it('defaults to testnet and the testnet Arcade', () => {
    const c = loadConfig({})
    expect(c.network).toBe('testnet'); expect(c.arcadeUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech'); expect(c.allowMainnetBroadcast).toBe(false)
  })
  it('mainnet default host', () => { expect(loadConfig({ BSV_NETWORK: 'mainnet' }).arcadeUrl).toBe('https://arcade-us-1.bsvblockchain.tech') })
  it('rejects other network values', () => { expect(() => loadConfig({ BSV_NETWORK: 'main' })).toThrow(/BSV_NETWORK/) })
  it('reads the version from package.json', () => { expect(loadConfig({}).version).toBe('2.0.0') })
})
describe('resolveNetwork', () => {
  const cfg = loadConfig({})
  it('rejects a testnet host on mainnet', () => {
    expect(() => resolveNetwork({ network: 'mainnet', arcadeUrl: 'https://arcade-testnet-us-1.bsvblockchain.tech' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a known mainnet host on testnet', () => {
    expect(() => resolveNetwork({ arcadeUrl: 'https://arcade-eu-1.bsvblockchain.tech' }, cfg)).toThrow(/mismatch/)
  })
  it('unknown host passes the cross-check', () => {
    expect(resolveNetwork({ arcadeUrl: 'http://localhost:8080' }, cfg)).toEqual({ network: 'testnet', arcadeUrl: 'http://localhost:8080' })
  })
  it('ttn host passes with a warning', () => {
    expect(resolveNetwork({ arcadeUrl: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech' }, cfg).warning).toMatch(/neither testnet nor mainnet/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — Run: `pnpm -F @bsv/mcp test test/config.test.ts` — Expected: FAIL (module not found)

- [ ] **Step 3: Implement `types.ts` and `config.ts`** per Interfaces.

- [ ] **Step 4: Run to verify pass** — Run: `pnpm -F @bsv/mcp test test/config.test.ts` — Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/config.ts packages/mcp/src/types.ts packages/mcp/test/config.test.ts
git commit -m "feat(mcp): config and types; network/host cross-check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Arcade client with recorded fixtures

**Files:**
- Create: `packages/mcp/src/arcade/client.ts`, `packages/mcp/src/arcade/classify.ts`, `packages/mcp/test/fixtures/arcade/{status-seen.json,status-mined-ef-rawtx.json,status-competing.json,status-rejected.json,submit-202.json,submit-400-476.json,submit-400-exists.json,submit-400-terminal.json,policy.json,health.json}`, `packages/mcp/test/helpers/mockFetch.ts`
- Test: `packages/mcp/test/arcade.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // classify.ts
  export function verdictOf(s: TransactionStatus): Verdict
  // seen-no-competitor: txStatus ∈ {SEEN_ON_NETWORK, SEEN_MULTIPLE_NODES, MINED, STUMP_PROCESSING, IMMUTABLE} and (competingTxs ?? []).length === 0
  // terminal: txStatus ∈ {REJECTED, DOUBLE_SPEND_ATTEMPTED}; pending: UNKNOWN, PENDING_RETRY, or any non-terminal status with competingTxs non-empty
  // on-network-not-seen: RECEIVED, SENT_TO_NETWORK, ACCEPTED_BY_NETWORK
  export function detectHexFormat(hex: string): 'beef' | 'ef' | 'raw'   // beef: /^(0100beef|0200beef|01010101)/i ; ef: /^[0-9a-f]{8}0000000000ef/i ; else raw
  export function classify400(body: { status?: number; error?: string; reason?: string; detail?: string; title?: string }): { kind: 'transient-476' | 'already-known' | 'terminal'; arcCode?: number }
  // already-known only on exact tokens 'TX_EXISTS' or 'txn-already-known' in reason/detail/error
  // client.ts
  export interface ArcadeClientOptions { baseUrl: string; timeoutMs?: number /* default 10000 */; fetchImpl?: typeof fetch }
  export class ArcadeClient {
    constructor(opts: ArcadeClientOptions)
    submit(hex: string, h?: { callbackUrl?: string; callbackToken?: string; fullStatusUpdates?: boolean }): Promise<{ postStatus: number; body: any; transient: boolean }>  // POST {base}/tx text/plain; never throws on HTTP errors; network error/timeout → { postStatus: 0, body: { error: 'UNREACHABLE' }, transient: true }
    status(txid: string, callbackToken?: string): Promise<TransactionStatus | { notFound: true }>
    policy(): Promise<{ policy: any; timestamp: string; satPerKb: number }>   // satPerKb = miningFee.satoshis * 1000 / miningFee.bytes
    health(): Promise<any>
    waitForSeen(txid: string, timeoutMs: number, intervalMs?: number /* 1000 */): Promise<TransactionStatus | { notFound: true }>  // polls until verdictOf ∈ {seen-no-competitor, terminal} or timeout
  }
  ```
  `mockFetch.ts`: `mockFetch(routes: Array<{ method: string; path: RegExp; status: number; body: any; delayMs?: number }>): typeof fetch` recording calls on `.calls`.

- [ ] **Step 1: Record the fixtures**

Run (network, one-off, no key involved): `curl -s https://arcade-testnet-us-1.bsvblockchain.tech/policy > packages/mcp/test/fixtures/arcade/policy.json; curl -s https://arcade-testnet-us-1.bsvblockchain.tech/health > packages/mcp/test/fixtures/arcade/health.json`. For status fixtures: pick any recently mined testnet txid from `https://test.whatsonchain.com` that was broadcast through this Arcade (try the latest block's txids until `GET /tx/{txid}` answers 200), save it as `status-mined-ef-rawtx.json` only if `rawTx` is present and `detectHexFormat(rawTx) === 'ef'`; otherwise hand-write the fixture from the OpenAPI shape with an EF `rawTx` built in a test helper (`Transaction` with `sourceTransaction` set → `toHexEF()`), and note `"_synthetic": true` in it. Hand-write `status-seen.json` (`SEEN_ON_NETWORK`, no `competingTxs`), `status-competing.json` (`SEEN_ON_NETWORK`, `competingTxs: ["<64 hex>"]`), `status-rejected.json` (`REJECTED`, `status: 466`, `extraInfo: "UTXO_SPENT"`), `submit-202.json` (`{txid,status:200,txStatus:"RECEIVED"}`), `submit-400-476.json` (`{error, status:476, title:"not final"}`), `submit-400-exists.json` (`{error:"...", reason:"txn-already-known"}`), `submit-400-terminal.json` (`{error, status:461}`). Fixture txids are real public txids or `"a".repeat(64)`.

- [ ] **Step 2: Write the failing tests**

Test names and assertions in `arcade.test.ts`: `verdictOf: seen-no-competitor for SEEN_ON_NETWORK without competitors`; `verdictOf: pending when competingTxs present`; `verdictOf: terminal for REJECTED`; `detectHexFormat: beef prefixes 0100beef, 0200beef, 01010101`; `detectHexFormat: ef marker after version`; `classify400: 476 is transient-476`; `classify400: txn-already-known is already-known`; `classify400: 461 is terminal with arcCode 461`; `submit posts text/plain to {base}/tx` (asserts `calls[0].headers['content-type'] === 'text/plain'`, path `/tx`); `submit returns transient UNREACHABLE on network error` (fetchImpl throws); `submit sets AbortSignal timeout` (fetchImpl receives `init.signal` instanceof AbortSignal); `status 404 returns notFound`; `policy derives satPerKb 1 from the testnet fixture`; `waitForSeen stops at seen-no-competitor` (routes: first call `RECEIVED`, second `SEEN_ON_NETWORK`; asserts 2 calls with `intervalMs: 1`); `waitForSeen returns last status on timeout`.

- [ ] **Step 3: Run to verify failure** — Run: `pnpm -F @bsv/mcp test test/arcade.test.ts` — Expected: FAIL

- [ ] **Step 4: Implement `classify.ts`, `client.ts`, `mockFetch.ts`** per Interfaces. Headers map: `callbackUrl → X-CallbackUrl`, `callbackToken → X-CallbackToken`, `fullStatusUpdates → X-FullStatusUpdates: 'true'|'false'`.

- [ ] **Step 5: Run to verify pass** — Run: `pnpm -F @bsv/mcp test test/arcade.test.ts` — Expected: PASS (15 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/arcade packages/mcp/test
git commit -m "feat(mcp): Arcade client, status classification, recorded fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `arcade_submit`, `arcade_status`, `arcade_policy`, `arcade_health` tools

**Files:**
- Create: `packages/mcp/src/tools/arcade.ts`, `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/tools-arcade.test.ts`

**Interfaces:**
- Produces: `server.ts` exports `createServer(cfg: Config, deps?: { fetchImpl?: typeof fetch }): McpServer` which registers everything (later tasks add their `register*` calls here); `tools/arcade.ts` exports `registerArcadeTools(server: McpServer, cfg: Config, fetchImpl: typeof fetch): void` and the pure handlers for tests: `arcadeSubmit(input, cfg, fetchImpl): Promise<SubmitResult>`, `arcadeStatus(input, cfg, fetchImpl): Promise<StatusResult>`. Tool schemas (zod raw shapes): `arcade_submit` `{ hex: z.string(), arcadeUrl?: z.string().url(), network?: z.enum(['testnet','mainnet']), waitForSeen?: z.boolean() (default true), timeoutMs?: z.number().int() (default 15000), callbackUrl?, callbackToken?, fullStatusUpdates?: z.boolean() }`; `arcade_status` `{ txid: z.string().regex(/^[0-9a-f]{64}$/i), arcadeUrl?, callbackToken? }`; `arcade_policy`/`arcade_health` `{ arcadeUrl? }`. Each tool returns `content: [{type:'text', text: JSON.stringify(result, null, 2)}]` and `structuredContent: result`; errors return `isError: true` with the message.

- [ ] **Step 1: Write the failing tests** (`tools-arcade.test.ts`, using `mockFetch` and `loadConfig({...})`):
  - `refuses BEEF before contacting Arcade`: hex `'0100beef' + 'aa'.repeat(40)` → rejects with `/convert to EF or raw/`; `fetch.calls.length === 0`.
  - `mainnet broadcast disabled without the flag`: `cfg = loadConfig({ BSV_NETWORK: 'mainnet' })` → error message exactly `mainnet broadcast disabled; set BSV_MCP_ALLOW_MAINNET_BROADCAST=1`; no fetch call.
  - `mainnet allowed with the flag`: `BSV_MCP_ALLOW_MAINNET_BROADCAST: '1'` → POST reaches `https://arcade-us-1.bsvblockchain.tech/tx`.
  - `2xx is provisional: re-reads status and waits for seen`: routes 202 then status `RECEIVED` then `SEEN_ON_NETWORK` → `verdict 'seen-no-competitor'`, `postStatus 202`, `txStatus 'SEEN_ON_NETWORK'`.
  - `476 is transient`: → `transient true`, `arcCode 476`, `txStatus 'UNKNOWN'` (no status read follows a 400), `verdict 'pending'`.
  - `already-known reads status`: 400 exists then status seen → `verdict 'seen-no-competitor'`.
  - `terminal 400 carries the ARC code`: → `verdict 'terminal'`, `arcCode 461`, `transient false`.
  - `503 is transient UNREACHABLE`: → `txStatus 'UNREACHABLE'`, `transient true`.
  - `ttn host returns a warning`.
  - `404 is no-verdict` (`arcadeStatus`): → `verdict 'no-verdict'`, `isFinalForApp false`, `note` matches `/never given this txid/`.
  - `status reports rawTx format ef with the EF reminder`: fixture `status-mined-ef-rawtx.json` → `rawTxPresent true`, `rawTxFormat 'ef'`, `note` matches `/re-read as plain/`.
  - `isFinalForApp false with competitors`.
  - `policy returns satPerKb`; `health returns version`.

- [ ] **Step 2: Run to verify failure** — Run: `pnpm -F @bsv/mcp test test/tools-arcade.test.ts` — Expected: FAIL

- [ ] **Step 3: Implement `tools/arcade.ts` and `server.ts`**. `server.ts`: `new McpServer({ name: '@bsv/mcp', version: cfg.version })`, then `registerArcadeTools(...)`. Keep `index.ts` untouched until Task 14.

- [ ] **Step 4: Run to verify pass** — Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/arcade.ts packages/mcp/src/server.ts packages/mcp/test/tools-arcade.test.ts
git commit -m "feat(mcp): arcade_submit/status/policy/health tools with mainnet guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Lint engine: walker, rule interface, suppression, shape detection

**Files:**
- Create: `packages/mcp/src/lint/engine.ts`, `packages/mcp/src/lint/walk.ts`, `packages/mcp/src/lint/shape.ts`, `packages/mcp/src/lint/rules/index.ts`, `packages/mcp/test/fixtures/projects/minimal/{package.json,src/a.ts,.gitignore,node_modules/x.js,dist/y.js}`
- Test: `packages/mcp/test/lint-engine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // walk.ts
  export interface ProjectFile { rel: string; abs: string; text: string; isClient: boolean /* under src/, app/, pages/, components/, web/, client/ and not under server/, api/, relay/, scripts/ */ ; isTest: boolean }
  export function walkProject(root: string, opts?: { include?: string[]; exclude?: string[] }): Promise<ProjectFile[]>
  // respects .gitignore via `ignore`; always skips node_modules, dist, build, .git, coverage; text files ≤ 1 MiB with ext in .ts .tsx .js .jsx .mjs .cjs .json .md .yaml .yml .html .env .env.example .toml
  // shape.ts
  export function detectShape(files: ProjectFile[]): ShapeDetected
  // A when /WalletClient\s*\(/ in a client file; B when /Setup\.createWallet|ServerWallet|go-wallet-toolbox|StorageKnex|WalletStorageManager/ anywhere
  // rules/index.ts
  export interface RuleContext { files: ProjectFile[]; shape: ShapeDetected; root: string; meta: GuardrailMeta }
  export interface RuleResult { findings: Omit<Finding,'ref'|'fix'>[]; applicable: boolean }
  export interface Rule { id: string; run(ctx: RuleContext): RuleResult }
  export const rules: Rule[]      // filled by Tasks 9–10
  // engine.ts
  export interface GuardrailMeta { id: string; title: string; shape: 'A'|'B'|'both'; detect: 'static'|'manual'|'contract'; severity: Severity; rule: string }
  export function loadGuardrailMeta(contentDir: string): GuardrailMeta[]    // from packages/mcp/content/guardrails.json
  export function isSuppressed(file: ProjectFile, line: number, id: string): boolean   // comment on `line` or `line-1`: /bsv-guardrail-ignore\s+G-\d\d/
  export function runGuardrails(root: string, opts: { shape?: 'A'|'B'|'auto'; include?: string[]; exclude?: string[]; contentDir: string }): Promise<GuardrailReport>
  // findings get fix = meta.rule (first sentence) and ref = `bsv://guardrails#${id}`; a static rule with no findings and applicable → passed; applicable false → notApplicable; detect manual/contract → manualChecklist; shape 'A' rules are notApplicable when shape is exactly 'B' and vice versa (shape 'auto' uses detectShape; 'unknown' treats all as applicable)
  ```

- [ ] **Step 1: Write the failing tests**

Test names: `walkProject skips node_modules, dist and .gitignore entries` (fixture `.gitignore` contains `secret.local.ts`; asserts `rel` list equals `['package.json','src/a.ts']`); `isClient is true for src/ and false for server/`; `detectShape A for WalletClient in src`; `detectShape A+B when both markers present`; `isSuppressed matches same line and line above`; `ignore comment suppresses a finding` (register a throwaway rule in the test that flags every line containing `FLAGME`; file has `// bsv-guardrail-ignore G-09 test` above the line; expect `passed` contains `G-09`); `manual rules land in manualChecklist` (expect `G-05` in `manualChecklist`); `shape B makes A-only rules notApplicable` (`shape: 'B'` → `G-01` in `notApplicable`).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement** per Interfaces.

- [ ] **Step 4: Run to verify pass** — Run: `pnpm -F @bsv/mcp test test/lint-engine.test.ts` — Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/lint packages/mcp/test
git commit -m "feat(mcp): guardrail lint engine (walker, suppression, shape detection)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Static rules, wallet and manifest group: G-01, G-02, G-03, G-04, G-06

**Files:**
- Create: `packages/mcp/src/lint/rules/{g01,g02,g03,g04,g06}.ts`
- Modify: `packages/mcp/src/lint/rules/index.ts` (push the five rules)
- Create fixtures: `packages/mcp/test/fixtures/projects/clean-a/` (a minimal shape-A project: `package.json`, `public/manifest.json` with identical `metanet.groupPermissions` and `babbage.groupPermissions`, one level-1 protocol, a level-2 entry with `counterparty`, `src/wallet.ts` using `WalletClient('auto', ORIGINATOR)`, `waitForAuthentication()`, `getNetwork()`, `createAction`, `src/config.ts` reading `BSV_NETWORK` with default `'testnet'`, `README.md` with `## Trust model`, `TRUST.md`), `packages/mcp/test/fixtures/projects/broken-a/` (same, with: `isAuthenticated()` used as a gate; `const network = process.env.BSV_NETWORK ?? 'mainnet'`; no `getNetwork` call; `public/manifest.json` deleted; `src/keys.ts` with `PrivateKey.fromRandom()` in client code; `.env` containing `SERVER_ROOT_KEY=0000…` (64 zeros, not a real key)) and `packages/mcp/test/fixtures/projects/broken-manifest/` (clean-a with a manifest whose `babbage.groupPermissions` differs from `metanet.groupPermissions` and whose level-2 entry has no `counterparty`)
- Test: `packages/mcp/test/rules-wallet.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext` from Task 8.
- Produces: rules with detection intent (regexes are the implementer's; each must match the fixture line and not match the clean fixture): G-01 flags `/\.isAuthenticated\s*\(/` in client files unless the file also contains `waitForAuthentication` AND the match is inside a `try` that is not awaited as a gate — simplify: flag every `isAuthenticated(` in client code (fix text names `waitForAuthentication()`); G-02 flags a string default of `'main'|'mainnet'` assigned to a variable/field named `/network|chain/i` (e.g. `?? 'mainnet'`, `|| 'main'`, `network: 'main'`), and flags once per project (file = the file calling `createAction`, line = that call) when `createAction(` appears and no file contains `getNetwork(`; G-03 flags once at `public/manifest.json` (line 0) when the file is missing, and at the file when either `metanet.groupPermissions` or `babbage.groupPermissions` is absent or the two differ; applicable only when shape includes A; G-04 flags each `protocolPermissions` entry whose `protocolID[0] === 2` and has no `counterparty`, and a `spendingAuthorization.amount > 100000` (warn); G-06 flags `PrivateKey.fromRandom|fromHex|fromWif|fromString` in client files, and any `.env` (not `.env.example`) line matching `/^(?!#).*(KEY|SECRET|WIF|MNEMONIC)\s*=\s*\S{32,}/`.

- [ ] **Step 1: Write the failing tests**

Test names (each runs `runGuardrails(fixtureRoot, { contentDir, shape:'auto' })`): `clean-a has no findings for G-01..G-06`; `broken-a: G-01 isAuthenticated gate`; `broken-a: G-02 mainnet default`; `broken-a: G-02 no getNetwork beside createAction`; `broken-a: G-03 missing manifest`; `broken-manifest: G-03 babbage differs`; `broken-manifest: G-04 level-2 without counterparty is warn`; `broken-a: G-06 PrivateKey in client`; `broken-a: G-06 key in .env`. Each asserts `findings.some(f => f.id === 'G-0x' && f.file === '<rel>' && f.severity === '<sev>')` and that the finding's `ref` is `bsv://guardrails#G-0x`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement the five rules and register them**

- [ ] **Step 4: Run to verify pass** — Run: `pnpm -F @bsv/mcp test test/rules-wallet.test.ts` — Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/lint/rules packages/mcp/test
git commit -m "feat(mcp): static guardrails G-01 G-02 G-03 G-04 G-06

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Static rules, broadcast and money group: G-09, G-10, G-12, G-14, G-15, G-16, G-21, G-25, G-31, G-34

**Files:**
- Create: `packages/mcp/src/lint/rules/{g09,g10,g12,g14,g15,g16,g21,g25,g31,g34}.ts`
- Modify: `packages/mcp/src/lint/rules/index.ts`
- Extend fixtures: `broken-a/src/broadcast.ts` (`import { ARC } from '@bsv/sdk'`, `new ARC('https://arc.taal.com', ...)`, a `fetch('https://api.whatsonchain.com/v1/bsv/test/tx/' + txid + '/hex')` inside a `for`/`while` loop, `Transaction.fromHex(status.rawTx)`, `fetch(ARCADE_URL + '/tx')` without `signal`, `if (status.txStatus === 'MINED') credit()`, a UI string `'Waiting for confirmation'`, `internalizeAction({ tx, outputs: [{ outputIndex: 0, protocol: 'wallet payment' }] })` without `paymentRemittance`); `broken-a/package.json` depends on `"runar-sdk": "0.4.6"` and `"@bsv/sdk": "3.0.0"`; `broken-a/README.md` without a trust section and no `TRUST.md`; `clean-a/src/broadcast.ts` with `fetch(url, { signal: AbortSignal.timeout(10000) })`, `Transaction.fromHexEF(status.rawTx)`, a `GET /tx/` read after the POST, `internalizeAction` with `paymentRemittance`
- Test: `packages/mcp/test/rules-broadcast.test.ts`

**Interfaces:**
- Produces rules (intent per spec §7; severities per schema): G-09 `import { ARC`/`new ARC(`/`'/v1/tx'`/`arc.taal.com`/`arc.gorillapool.io`/WoC `/tx/raw` → error; G-10 `'MINED'` or `.confirmations` in a branch/condition (`if`, `===`, `switch`, `while`) in a non-test file, or a file that `fetch`es `/tx` with `method: 'POST'` and has no `/tx/` GET read → error; G-12 WoC `/tx/<...>/hex` fetched in a client file, or any file with a WoC URL inside a loop (`for`/`while`/`.map(`/`Promise.all(` within 10 lines), or a file calling WoC with no limiter token (`limiter|throttle|gate|queue|Bottleneck|p-limit|setTimeout`) → error; G-14 UI strings `/wait(ing)? for (a )?confirmation/i` in client files, or `confirmations\s*>=?\s*\d` → warn; G-15 `fetch(` whose URL text contains `arcade|whatsonchain|ARCADE_URL|WOC` and whose init (same statement, up to 5 lines) lacks `signal` → warn; G-16 `Transaction.fromHex(` applied to an identifier containing `rawTx` (and not `fromHexEF`), or a loop containing `/tx/` + `hex` → error; G-21 `internalizeAction(` where the same statement (up to 30 lines) lacks `paymentRemittance`, or an output object containing both `basketInsertion`/`'basket insertion'` and `'wallet payment'` → error; G-25 `package.json`/lockfile pins `runar-sdk|runar-lang|runar-testing` at `0.4.x` from npm → error, and `runar-sdk` imported in a client file of a Vite project whose `vite.config.*` lacks `node:url` alias → error; G-31 compares `package.json` dependency versions of names present in `content/versions.json#packages` and flags a pin whose major.minor is lower than pinned → warn; G-34 no `TRUST.md` and no README heading matching `/trust model/i` → warn.

- [ ] **Step 1: Write the failing tests**

Test names: `clean-a has zero errors overall` (`findings.filter(f=>f.severity==='error')` is `[]`); `broken-a: G-09 ARC class`; `broken-a: G-09 arc.taal.com`; `broken-a: G-10 MINED branch`; `broken-a: G-12 WoC hex loop`; `broken-a: G-14 waiting for confirmation (warn)`; `broken-a: G-15 fetch without signal (warn)`; `broken-a: G-16 fromHex(rawTx)`; `broken-a: G-21 missing paymentRemittance`; `broken-a: G-25 runar 0.4.6`; `broken-a: G-31 @bsv/sdk 3.0.0 behind 3.2.1 (warn)`; `broken-a: G-34 no trust model (warn)`; `exit-criterion set is all errors` (asserts ids `G-09, G-01, G-02, G-12, G-03` all appear with `severity 'error'` in `broken-a`).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement the ten rules and register them**; `rules.length === 15` after this task.

- [ ] **Step 4: Run to verify pass** — Run: `pnpm -F @bsv/mcp test` — Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/lint/rules packages/mcp/test
git commit -m "feat(mcp): static guardrails G-09 G-10 G-12 G-14 G-15 G-16 G-21 G-25 G-31 G-34

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `check_guardrails` tool

**Files:**
- Create: `packages/mcp/src/tools/guardrails.ts`
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/tools-guardrails.test.ts`

**Interfaces:**
- Consumes: `runGuardrails` (Task 8).
- Produces: `registerGuardrailTools(server, cfg)`; tool `check_guardrails` input `{ path: z.string(), shape?: z.enum(['A','B','auto']) (default 'auto'), include?: z.array(z.string()), exclude?: z.array(z.string()) }`, output `GuardrailReport` as `structuredContent` plus a text summary whose first line is `check_guardrails: <n> errors, <m> warnings, shape <shapeDetected>`; `contentDir` resolves to `packages/mcp/content` relative to the built file (`new URL('../../content', import.meta.url)`); a non-existent `path` → `isError` with `path not found`.

- [ ] **Step 1: Write the failing tests**: `summary line counts errors and warnings` (on `broken-a`, first text line matches `/^check_guardrails: \d+ errors, \d+ warnings, shape A$/`); `clean-a reports 0 errors`; `missing path is an error`; `tool is registered with the name check_guardrails` (use `@modelcontextprotocol/sdk/client` + `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`, call `client.listTools()`, expect the name present).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement and register in `server.ts`**

- [ ] **Step 4: Run to verify pass** — Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src packages/mcp/test
git commit -m "feat(mcp): check_guardrails tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `brc_lookup` (fixed), `docs_url`, `versions_check`, `code_search`, `find_function_definition`

**Files:**
- Create: `packages/mcp/src/tools/brc.ts`, `packages/mcp/src/tools/docs.ts`, `packages/mcp/src/tools/versions.ts`, `packages/mcp/src/tools/search.ts`, `packages/mcp/src/cli/versions-check.ts`
- Modify: `packages/mcp/src/server.ts`, `packages/mcp/package.json` (add bin `bsv-mcp-versions-check: build/cli/versions-check.js`)
- Test: `packages/mcp/test/tools-lookup.test.ts`

**Interfaces:**
- Produces:
  - `brc.ts`: `normalizeBrcId(input: string): string | null` (`'1'`,`'0001'`,`'BRC-1'`,`'brc1'`,`' brc-0001 '` → `'0001'`; non-numeric → `null`); `lookupBrc(id: string, cfg: Config, fetchImpl): Promise<{ markdown: string; source: 'local'|'github'; url: string }>`: local = `${cfg.reposDir}/BRCs/<category>/<id>.md` across every directory in the clone (readdir, no hardcoded list); fallback `https://raw.githubusercontent.com/bsv-blockchain/BRCs/master/<category>/<id>.md` using `content/brc-categories.json#index[id]` first, then every category in `categories`; tool `brc_lookup` input `{ brc: z.string() }`; also `registerBrcResource(server)` with `new ResourceTemplate('bsv://brc/{id}', { list: undefined })` backed by the same function (Task 13 calls it).
  - `docs.ts`: `export interface DocsIndex { hosts: string[]; ids: Record<string, { path: string; title: string; legacy?: string }> }` (the parsed `packages/mcp/content/docs-index.json`); `resolveDocsUrl(id: string, index: DocsIndex, fetchImpl): Promise<{ id, title, url: string, markdownUrl: string, host: string } | { id, error: string, tried: string[] }>`; tries `<host><path>.md` for each host in order, then `legacy`; a hit = HTTP 200 whose body does not start with `# Page Not Found`; `url` = the `.md` URL without the suffix; tool `docs_url` input `{ id: z.string() }`; unknown id lists the known ids in the error.
  - `versions.ts`: `versionsCheck(versions: VersionsFile, fetchImpl, opts?: { probe?: boolean }): Promise<{ rows: VersionRow[]; rawTxProbe?: { txid: string; rawTxPresent: boolean; txStatus: TxStatus } }>`: npm `https://registry.npmjs.org/<name>/latest` → `version`; GitHub `https://api.github.com/repos/icellan/runar/commits/main` → `sha.slice(0,7)` vs `commit`; Arcade `/health` on every host in `services.arcade.hosts.testnet` and `.mainnet` → row per host (`name: 'arcade:<host>'`, `pinned: version`, `latest: health.version`); `drift = latest !== pinned` (for `runar-sdk` the row's `note` says npm is unsafe and `drift` is `false` when npm still lags); `ageDays` from `verified`; the probe runs only when `probeTxid` is non-empty. Tool `versions_check` takes no input and returns `{ rows, rawTxProbe }`. `cli/versions-check.ts`: prints the rows as a Markdown table, `--json` prints JSON, exit 1 when any `drift` or any `ageDays > --max-age-days` (default 60).
  - `search.ts`: the existing `code_search` and `find_function_definition` behaviour moved from `index.ts`, registered with `registerTool`; when `cfg.reposDir` is unset or missing they return `isError` with text `BSV_REPOS_DIR is not set; run setup.sh <dir> and set BSV_REPOS_DIR=<dir>`.

- [ ] **Step 1: Write the failing tests**: `normalizeBrcId variants`; `brc_lookup finds a category the old list missed` (temp `BSV_REPOS_DIR` with `BRCs/scripts/0014.md`; expect `source 'local'`); `brc_lookup falls back to GitHub with the index category` (mock fetch; asserts URL `.../payments/0029.md` fetched first); `docs_url prefers writedocs when both answer` (mock both 200 → `host` is `https://bsv.writedocs.io/docs/`); `soft 404 is a miss` (first host 200 with body `# Page Not Found\n...`, second 200 real → second URL); `docs_url falls to legacy`; `docs_url unknown id lists ids`; `versionsCheck flags drift and age` (mock registry returns `3.3.0` for `@bsv/sdk` → `drift true`; `verified` 100 days ago → `ageDays ≥ 100`); `versionsCheck skips the probe when probeTxid is empty`; `code_search without BSV_REPOS_DIR returns the setup hint`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement the four modules and the CLI; register in `server.ts`**

- [ ] **Step 4: Run to verify pass** — Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): brc_lookup across all categories, docs_url host fallback, versions_check, search tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Resources and prompts

**Files:**
- Create: `packages/mcp/src/resources/index.ts`, `packages/mcp/src/prompts/index.ts`
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/resources-prompts.test.ts`

**Interfaces:**
- Produces: `registerResources(server, cfg, fetchImpl)` registering the 16 URIs listed in Cross-plan interfaces (`mimeType: 'text/markdown'` for `.md`, `'application/json'` for `bsv://docs/index`); every body is prefixed with `verified: <date from the file's frontmatter>\nsource: @bsv/mcp v<version>\n\n` (for `bsv://guardrails` the rendered Markdown comes from `guardrails.json`, one `## G-xx <title>` per rule so `#G-xx` anchors resolve); `registerPrompts(server)` registering `review_against_guardrails` (`argsSchema { path: z.string() }`; message instructs: call `check_guardrails` on `path`, fix every `error`, then walk `manualChecklist` ids one by one against `bsv://guardrails`), `tokenize_with_1color` (`{ assetId?: z.string(), mode: z.enum(['deploy','transfer','mint']) }`; points at `bsv://facts/tokens-1color` and states phase-1 scope), `integrate_simple` (`{ framework: z.enum(['next','express','react','node']) }`), `add_simple_feature` (`{ feature: z.enum(['payments','tokens','inscriptions','messagebox','certificates','did','overlay']) }`), `debug_simple` (`{ symptom: z.string() }`); each simple prompt tells the agent to read `bsv://simple/api` and `bsv://simple/gotchas`, to pass `network: 'testnet'`, and to route anything needing Arcade tracking to `@bsv/sdk` + `arcade_submit`.

- [ ] **Step 1: Write the failing tests** (in-memory client): `lists all 15 static resources and the brc template` (`client.listResources()` names ⊇ the list; `client.listResourceTemplates()` contains `bsv://brc/{id}`); `every resource body starts with verified: and source:` (regex `/^verified: \d{4}-\d{2}-\d{2}\nsource: @bsv\/mcp v2\.0\.0\n/`); `guardrails resource has 34 headings`; `lists the five prompts`; `prompt names have no leading slash`; `review_against_guardrails mentions check_guardrails and manualChecklist`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement and register**

- [ ] **Step 4: Run to verify pass** — Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): bsv:// resources and prompts (simple-mcp prompts folded in)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `index.ts` bootstrap, stdio smoke test, no boot dependency on `BSV_REPOS_DIR`

**Files:**
- Modify: `packages/mcp/src/index.ts` (rewrite: `#!/usr/bin/env node`, `loadConfig()`, `createServer(cfg)`, `StdioServerTransport`, log one line to stderr `@bsv/mcp v2.0.0 network=testnet arcade=<url> repos=<set|unset>`; exit 1 only on a config error)
- Test: `packages/mcp/test/stdio.test.ts`

**Interfaces:**
- Consumes: `createServer` (Task 7).

- [ ] **Step 1: Write the failing test**: `starts over stdio without BSV_REPOS_DIR and lists 10 tools` (spawn `node build/index.js` with `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`, `env: { PATH, BSV_NETWORK: 'testnet' }`; `listTools()` names equal the ten in Cross-plan interfaces, sorted; `initialize` result `serverInfo.name === '@bsv/mcp'` and `.version === '2.0.0'`); `rejects BSV_NETWORK=main with exit code 1`.

- [ ] **Step 2: Run to verify failure** — Run: `pnpm -F @bsv/mcp build && pnpm -F @bsv/mcp test test/stdio.test.ts` — Expected: FAIL (old index exits on missing `BSV_REPOS_DIR`)

- [ ] **Step 3: Rewrite `index.ts`**

- [ ] **Step 4: Run to verify pass** — Expected: PASS (2 tests); `pnpm -F @bsv/mcp test` all green.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): stdio bootstrap without boot dependency on BSV_REPOS_DIR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: `setup.sh`, README, CHANGELOG, root docs

**Files:**
- Modify: `setup.sh` (rewrite), `README.md` (rewrite), create `CHANGELOG.md`, `packages/mcp/README.md`, `samples/README.md` (placeholder listing `tipping-shape-a` as "phase 1, see plan 1c")
- Test: `packages/mcp/test/setup-sh.test.ts`

**Interfaces:**
- Produces: `setup.sh <target_dir>` clones (`--depth 1`) exactly `https://github.com/bsv-blockchain/ts-stack`, `bsv-blockchain/BRCs`, `bsv-blockchain/arcade`, `bsv-blockchain/bsv-desktop`, `bsv-blockchain/go-wallet-toolbox`, `icellan/runar`; prints `export BSV_REPOS_DIR=<target_dir>` at the end; `--list` prints the URLs one per line and exits 0 without cloning.

- [ ] **Step 1: Write the failing test**: `setup.sh --list prints the six repos` (spawn `bash setup.sh --list`, expect exactly those six URLs, in order; no `bitcoin-sv/`).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Rewrite `setup.sh`; write the READMEs and CHANGELOG**

Root `README.md` sections: `## What is here` (repo map: content/, packages/mcp, packages/skill, packages/sync, samples/, docs/), `## Install` (the three commands: `npx skills add bsv-blockchain/bsv-mcp`; `claude plugin marketplace add bsv-blockchain/bsv-mcp && claude plugin install bsv-dev@bsv`; `claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp`), `## @bsv/mcp tools` (the ten tools, one line each; `brc_lookup` says "local clone first, GitHub fallback"), `## Resources and prompts`, `## Environment` (the six variables), `## Safety` (testnet default, mainnet flag, no keys), `## Development` (pnpm build/test/sync), `## Release` (tag `v*`, trusted publishing), `## License`. `packages/mcp/README.md`: the npm-facing subset (ships in the tarball). `CHANGELOG.md`: `## 2.0.0 (unreleased)` listing the v2 changes and §5.4 removals.

- [ ] **Step 4: Run to verify pass**; also `grep -n "server-filesystem\|bitcoin-sv/\|fetches directly from GitHub" README.md` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add setup.sh README.md CHANGELOG.md packages/mcp/README.md samples/README.md packages/mcp/test/setup-sh.test.ts
git commit -m "docs: setup.sh for bsv-blockchain repos, README for the monorepo and @bsv/mcp 2.0.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: CI, nightly and release workflows; delete the old ones

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`, `.github/workflows/release.yml`, `scripts/anti-goals.sh`
- Delete: `.github/workflows/push.yaml`, `.github/workflows/npm-publish.yml`
- Test: `packages/sync/test/anti-goals.test.ts`

**Interfaces:**
- Produces: `scripts/anti-goals.sh` greps `content/ packages/skill/skills docs/writechoice samples/*/README.md` for the forbidden phrasings (`wait for confirmation`, `waiting for confirmation`, `/v1/tx`, `ARC_URL`, `fetch the parent from WhatsOnChain`, `new ARC(`, `import { ARC`) and exits 1 unless every hit's line contains one of the allowlist markers `never`, `not `, `don't`, `anti-goal`, `forbidden`, `G-0`, `G-1` (the "never do this" sentences). `ci.yml` (on `pull_request` and `push` to `main`): job `build-test` (Node 22, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`); job `content` (`pnpm sync:check`, `pnpm check:facts --max-age-days 60`, `bash scripts/anti-goals.sh`). `nightly.yml` (`schedule: cron '17 4 * * *'` + `workflow_dispatch`; `permissions: issues: write, contents: read`): job `freshness` runs `node packages/mcp/build/cli/versions-check.js --json > drift.json; exit code captured`, `pnpm check:links`, an `llms.txt` diff step (fetch `https://docs.bsvblockchain.org/llms.txt`, list `/docs/<path>.md` links absent from `docs-index.yaml` and ids whose path is absent from llms.txt), then a step using `gh issue list --search 'Freshness: content drift in:title' --state open --json number` to create or edit the single issue body with the table when anything drifted; the job fails when `check:facts` reports a fact older than 60 days. `release.yml` (`on: push: tags: ['v*']`; `permissions: id-token: write, contents: write`): job `publish`: Node 22 with `registry-url: https://registry.npmjs.org`, `npm install -g npm@latest` (trusted publishing needs npm ≥ 11.5.1), `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm sync:check`, a guard that `packages/mcp/package.json` version equals the tag without `v`, `cd packages/mcp && npm publish --access public` (no token; provenance is automatic under OIDC), then `gh release create "$GITHUB_REF_NAME" --generate-notes` with `env: GH_TOKEN: ${{ github.token }}` (plan 1b attaches the skill zip here).

- [ ] **Step 1: Write the failing test**: `anti-goals.sh passes on the repo` (spawn, exit 0) and `anti-goals.sh fails on a forbidden phrase` (temp dir with `wait for confirmation` on an unmarked line; run the script with the dir as `$1`; exit 1).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (script missing)

- [ ] **Step 3: Write the script and the three workflows; `git rm` the two old ones**

- [ ] **Step 4: Verify**: `pnpm -F @bsv/sync test`; `ls .github/workflows` prints exactly `ci.yml nightly.yml release.yml`; `npx -y action-validator .github/workflows/*.yml` (or `actionlint` if installed) reports no errors.

- [ ] **Step 5: Commit** (one commit, so no `main` push ever runs a publish)

```bash
git add -A .github scripts packages/sync/test
git commit -m "ci: ci/nightly/release workflows with trusted publishing; remove push.yaml and npm-publish.yml

HUMAN: Connor confirms with Deggen that the ts-sdk sync is dead and sets up npm trusted publishing (workflow release.yml) before any v* tag.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

HUMAN: Connor — confirm with Deggen that the go-broadcast sync to this repo is inactive; have Deggen add the trusted publisher for `@bsv/mcp` on npmjs.com (organization `bsv-blockchain`, repository `bsv-mcp`, workflow `release.yml`, no environment). Nothing here blocks other tasks.

---

### Task 17: `@bsv/simple-mcp` deprecation PR materials

**Files:**
- Create: `docs/deprecation/simple-mcp/README.md` (instructions), `docs/deprecation/simple-mcp/files/src/index.ts`, `docs/deprecation/simple-mcp/files/package.json`, `docs/deprecation/simple-mcp/files/README-banner.md`, `docs/deprecation/simple-mcp/PR-body.md`
- Test: `packages/sync/test/deprecation.test.ts`

**Interfaces:**
- Produces: a drop-in replacement for `bsv-blockchain/simple-mcp` (today `@bsv/simple-mcp` 0.0.2, `@modelcontextprotocol/sdk ^1.11`, bin `simple-mcp`): `files/src/index.ts` is a complete ~40-line server named `@bsv/simple-mcp` version `0.0.3` that on start prints to stderr `@bsv/simple-mcp is deprecated. Install @bsv/mcp: claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp` and registers exactly one resource `simple://deprecated` (Markdown pointing at `@bsv/mcp` and the `bsv://simple/api`, `bsv://simple/gotchas` resources and the three prompts) and no tools; `files/package.json` = the current one with `version "0.0.3"` and `"deprecated": "Replaced by @bsv/mcp 2.x"`; `README-banner.md` = the banner to prepend; `PR-body.md` = the PR description (what changed, the `npm deprecate @bsv/simple-mcp "Replaced by @bsv/mcp 2.x: npm i -g @bsv/mcp" ` command for the owner, "archive after the docs page is updated", ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`); `README.md` = step list for the human (fork/branch, copy files, build, open PR, owner publishes 0.0.3, owner runs `npm deprecate`, archive).

- [ ] **Step 1: Write the failing test**: `deprecation index.ts compiles standalone` (copy `files/` to a temp dir, `npm init -y`-style minimal `package.json` is already there; run `npx -y -p typescript@5 tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck src/index.ts` after `npm i --no-save @modelcontextprotocol/sdk@1.32.1 zod@3.25`; exit 0); `prints the deprecation notice on start` (spawn `node --import tsx src/index.ts`, stderr contains `deprecated`).

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Write the files**

- [ ] **Step 4: Run to verify pass** — Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add docs/deprecation packages/sync/test/deprecation.test.ts
git commit -m "docs: prepared @bsv/simple-mcp 0.0.3 deprecation release and PR materials

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

HUMAN: Connor — arrange owner sign-off on `bsv-blockchain/simple-mcp`; the owner opens/merges the PR, publishes 0.0.3, runs `npm deprecate`, archives after WriteChoice updates `/docs/build-with-ai`.

---

## Self-review notes (applied)

- Spec coverage: §4 layout (Tasks 1–4), §5 env/tools/resources/prompts/§5.4 removals (Tasks 5–14), §7 every `static` rule (Tasks 9–10: G-01, 02, 03, 04, 06, 09, 10, 12, 14, 15, 16, 21, 25, 31, 34 = 15 rules), §9 workflows/trusted publishing/deprecation (Tasks 16–17), §12 suppression comment (Task 8). `scaffold_app`/`contract_review` are phase 2 and absent on purpose.
- Spec deviations recorded: `severity` added to `guardrails.yaml`; `docs-index.yaml` carries host prefixes including `/docs/` (verified); `custody-shapes.md` and `threat-model.md` are generated into the skill by sync (keeps sync one-directional); `arcadeUrl` host cross-check passes unknown hosts.
- Could not verify: whether `rawTx` on a `MINED` testnet status is still EF today (Task 6 records a fixture if so, else synthesises one and marks it); `action-validator`/`actionlint` availability (Task 16 offers either).

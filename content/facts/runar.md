---
title: Rúnar contracts
verified: 2026-10-22
source: "@bsv/mcp content"
---

# Rúnar

Rúnar compiles TypeScript-style contract classes to Bitcoin Script. Use it for every contract, and take it from upstream source, not npm.

## Version state

| Source | Version | Status |
| --- | --- | --- |
| npm `runar-sdk` (and siblings) | 0.4.6 | Stale and unsafe. Its stateless `checkPreimage` is forgeable. Never use it. |
| `icellan/runar` branch `main` | commit `d207ee8` (2026-09-18), packages at `1.0.0-rc.1` | Use this. No release or tag exists for 1.0 (tags stop at `v0.4.6`), and there were no newer commits on 2026-10-22. |

Pin the commit, vendor the built packages, and commit the compiled contract artifact.

## Build recipe

1. Install pnpm (the repo uses pnpm workspaces and turbo).
2. Clone `https://github.com/icellan/runar`, check out `main` at the pinned commit.
3. `pnpm install` and `pnpm build` at the repo root.
4. `pnpm pack` each package you need (`runar-lang`, `runar-compiler`, `runar-ir-schema`, `runar-sdk`, `runar-testing`). Packing rewrites their `workspace:*` dependencies to real versions.
5. Copy the tarballs into your repo (for example `vendor/runar/`) and point every `runar-*` name at them with `pnpm.overrides` in the root `package.json`, so no copy resolves from npm.
6. Add `fast-check` to your own dependencies if you use `runar-testing`: it is declared there only as a dev dependency.

Record the commit and the rebuild steps next to the tarballs.

## 1.0.0-rc.1 behaviour to know

- Give a private method's result a typed local before doing arithmetic on it.
- Only bounded `for` loops compile, and each iteration is unrolled into the script. Unbounded loops, recursion and closures are rejected.
- The compiler caps the stack at 800 items.
- `this.buildP2PKH` is documented but missing in rc.1; build P2PKH outputs another way.
- Each public method has a fixed set of outputs. Plan methods around the exact outputs they create.
- A stateful state transition carries the contract script three times: in the preimage's script code, in the code part pushed by the unlocking script, and in the recreated output. Size fees accordingly (see the `fees` facts).
- `StatefulSmartContract` in rc.1 has a sound OP_PUSH_TX binding, and `addOutput` pins the continuation amount. `_changePKH` and `_changeAmount` are chosen by the spender and are not pinned unless a signature covers the outputs. A terminal method that pays out must pin its outputs itself: `hash256(serializedOutputs) == extractOutputHash(txPreimage)`.
- `extractLocktime` returns the raw field. Every height check must also assert `nLockTime < 500000000`.
- `TestContract` in `runar-testing` mocks `checkSig`. Test signature and preimage behaviour with real transactions through `@bsv/sdk` `Spend`.
- The SDK's `call()` cannot add fee inputs or payout outputs. Build settlement transactions with `@bsv/sdk` and Rúnar's `buildUnlockingScript` (stateless) or its `encodeArg` / `encodePushData` / `encodeScriptNumber` helpers in the stateful layout `<codePart> <args…> <_changePKH> <_changeAmount> <preimage> <methodIndex>`. Never hand-assemble unlocking scripts.

## Browser builds

`runar-ir-schema` calls `fileURLToPath(import.meta.url)`, which crashes every browser page that imports it. In Vite, alias `node:url`, `node:path` and `node:fs` to browser shims, and add a build check that fails when any unshimmed Node builtin reaches the bundle.

Ship a slim artifact to the browser: `script`, `abi`, `stateFields`, `constructorSlots`, `codeSeparator` and `version`. The full compiler output inlines about 1 MB of source maps.

## Rabin signatures

BSV script has no data-signature opcode, so a signature over arbitrary data is checked with `verifyRabinSig` (about 50 bytes of script). The check is

`(sig² + padding) mod n == LE_uint256(SHA256(msg))`

where `LE_uint256` reads the 32-byte digest as a little-endian unsigned integer and the public modulus `n` must be larger than 2^256. BRC-100 wallets sign ECDSA only, so a Rabin key lives outside the standard wallet calls unless the wallet has a Rabin module (BRC-206, draft).

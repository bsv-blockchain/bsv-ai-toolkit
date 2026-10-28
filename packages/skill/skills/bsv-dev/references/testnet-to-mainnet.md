# Testnet first, then mainnet on purpose

Applies to: both
Guardrails: G-02, G-11, G-12, G-19, G-24, G-29, G-33

Build and test on testnet. Mainnet is real money: the app switches to it only when the operator sets `BSV_NETWORK=mainnet` on purpose, after the checklist below. Hosts, faucet and rates per network are in `facts.md` (section "Networks").

## One variable

- **`BSV_NETWORK`** (`testnet` or `mainnet`; unset means `testnet`) is the one setting that picks the network. The server and the client both use it. Derive everything else from it: the Arcade URL (unless `ARCADE_URL` overrides it), the WhatsOnChain base, wallet-toolbox's `Chain` (`'test'` or `'main'`) and `@bsv/simple`'s `'testnet'` or `'main'` (`simple-routing.md`).
- **One name, even in the browser.** When the bundler only exposes variables with a public prefix (`VITE_`, `NEXT_PUBLIC_`), the prefixed copy must be derived from `BSV_NETWORK` at build time (for example in the bundler config), never set separately, or the browser and the server can disagree.
- **A startup check in app code.** At startup the app reads the network value it actually uses (after its framework has loaded any `.env*` files) and refuses to start unless it is exactly `testnet` or `mainnet`; on `mainnet` it logs the banner `*** MAINNET: real money. BSV_NETWORK=mainnet ***`. This startup check is the evidence of which network the app is on.
- **`scripts/network-guard.sh` checks only the environment it runs in.** It prints `network: testnet` or the mainnet banner and exits 2 on any other value. Run as a `predev` or `prestart` script it sees the shell's environment, not `.env*` files the framework loads later, and serverless hosts never run `prestart`. Use it as an early shell check, never instead of the startup check.
- **`getNetwork()` must match.** Read the user's wallet network before every money path and refuse on a mismatch (G-02, `wallet-brc100.md`). Show the network in the UI.
- **No second opt-in for apps.** Setting `BSV_NETWORK=mainnet` is the decision. Never read `BSV_MCP_ALLOW_MAINNET_BROADCAST` in app code: it only lets the agent's `arcade_submit` tool broadcast on mainnet during development.

```ts
export function checkNetwork(value = process.env.BSV_NETWORK || 'testnet'): 'testnet' | 'mainnet' {
  if (value !== 'testnet' && value !== 'mainnet') throw new Error(`BSV_NETWORK must be testnet or mainnet (got: ${value})`)
  if (value === 'mainnet') console.warn('*** MAINNET: real money. BSV_NETWORK=mainnet ***')
  return value
}
```

## Faucet

- **`https://bsvfaucet.com`**: sign in with a BSV wallet, up to 10M sats per request, 24 h cooldown (verified 2026-10-22).
- Getting the coins is the user's step: tell them to switch BSV Desktop to testnet, open the faucet and send the coins to that wallet, then wait for them to confirm. Never automate the faucet.
- A shape B server wallet on testnet is funded from the user's testnet wallet through the app's "fund the server" path (`custody-shapes.md`). Test and bot wallets derive deterministic keys from a seed held outside the repository (G-24).
- Mainnet has no faucet: the operator buys BSV.

## Fee reality

| | testnet | mainnet |
| --- | --- | --- |
| Arcade minimum (`GET /policy`) | 1 sat/kB | 100 sat/kB on every datahub Arcade reports |
| Rate to configure | 100 sat/kB, so sizes and costs carry over | 100 sat/kB |

- Size every fee from the serialized draft at the configured rate (default 100 sat/kB), never below what `GET /policy` reports and never from a guessed size (G-29). `scripts/arcade-check.sh --policy` prints `satPerKb`.
- An app that pays testnet's 1 sat/kB is refused on mainnet (code 465, fee too low). Configure 100 sat/kB from the start.
- Measured sizes and fees for common transactions are in `facts.md` (section "Fee rates and measured costs"); they were measured on testnet.

## Mainnet checklist

Walk it with the user before anyone sets `BSV_NETWORK=mainnet`:

- [ ] **Gate run on mainnet.** Every transaction kind, at full size, once, with small amounts: record bytes, fees and statuses (G-33). Everything in this kit was measured on testnet; mainnet rates, reserve sizing and BSV Desktop's mainnet behaviour need their own run.
- [ ] **Reserve sizing.** Recompute reserves and operator budgets at 100 sat/kB from the measured sizes; keep per-action caps, per-identity rates and a daily budget (G-19).
- [ ] **BSV Desktop switched to mainnet** by the user, and the app's `getNetwork()` check passes.
- [ ] **`BSV_NETWORK=mainnet` set on purpose** by the operator in the deployed environment; the app's own startup check logs the mainnet banner. `ARCADE_URL` is empty or a mainnet host, never a testnet or ttn host.
- [ ] **Shape B storage and keys decided.** The root key lives outside the repository, set by the operator; wallet storage is chosen and backed up; the funding address is printed.
- [ ] **The agent flag stays with the agent.** `BSV_MCP_ALLOW_MAINNET_BROADCAST=1` is only for agent broadcasts through `arcade_submit`; the user sets it, the agent never does.
- [ ] **Show the user every transaction before broadcast:** each output (destination and amount), the total, the fee and the network. On mainnet each broadcast is approved on its own.

## On 429 / 476 / FEE_TOO_HIGH

- **429 from WhatsOnChain.** The free tier allows about 3 requests per second per IP, and hosts that share egress hit it sooner. Retry through one process-wide gate with at least 350 ms spacing and an exponential backoff (2 s × 2^attempt, bounded), as in `arcade-0conf.md` ("WhatsOnChain fallback"). With an API key, send `WOC_API_KEY` as the raw `Authorization` header value. Ask Arcade, not WhatsOnChain, about any txid you know (G-12).
- **476 from Arcade** (a 400 whose `status` is 476). Not final: the `nLockTime` is ahead of median-time-past, which lags the clock by up to about an hour, and an input is non-final. It is transient: nothing was persisted and `GET /tx/{txid}` keeps its prior answer. Re-post the identical transaction after the lock time passes, on a bounded schedule (every few minutes). It is not a fee or network fault (G-11).
- **`FEE_TOO_HIGH`.** An app-side fee cap refused a correctly sized transaction because the cap or the estimate assumed a size far below the real one (a few hundred bytes for a transaction carrying a 9.6 KB output). Retrying the same draft will not help: re-size the fee from the serialized draft at the configured rate (default 100 sat/kB), never below what `GET /policy` reports, and keep a cap only where an overpay would harm a counterparty.

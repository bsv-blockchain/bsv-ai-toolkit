import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

function userMessage(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] }
}

// App code owns its runtime gate; the MCP tools are the dev-time equivalent.
const ARCADE_GATE =
  "In app code, submit to the app's own Arcade client (`POST /tx` as EF hex) and gate on `GET /tx/{txid}`: final at `SEEN_ON_NETWORK` or later with no `competingTxs`; never wait for `MINED`. " +
  'While developing, `arcade_submit`/`arcade_status` do the same from here.'

// The kit's rules for every money path, shared by the build prompts.
const BROADCAST_RULES = [
  `Broadcast and status go through Arcade. ${ARCADE_GATE}`,
  'Never use the legacy ARC API, and never treat WhatsOnChain as the source of truth for a txid you know: Arcade answers for it.',
  'Never ask for, read, print, log or commit a private key, WIF or seed phrase. Server keys come from the environment and stay out of the repo.',
].join('\n- ')

const SIMPLE_RULES = [
  'Read `bsv://simple/api` and `bsv://simple/gotchas` before writing code.',
  "Pass `network: 'testnet'` to `createWallet`, `ServerWallet.create` and `ServerWalletManager` (they default to `'main'`, real money), and `'testnet'` to `Overlay.create`. " +
    'Take the value from one `BSV_NETWORK` setting; mainnet only by explicit configuration.',
  "Network values: the kit's `BSV_NETWORK` is `testnet|mainnet`; `@bsv/simple` wallets take `'testnet'|'main'` (map `mainnet` to `'main'`); `Overlay.create` takes `'testnet'|'mainnet'`.",
  'In the browser, `network` is only a label: call `wallet.getClient().getNetwork({})` and refuse money paths when the wallet is on another network.',
  '`@bsv/simple` has no Arcade option. For any step that needs Arcade tracking (the 0-conf gate, `competingTxs`, rejection reasons), drop to `@bsv/sdk` for that step: ' +
    `take the transaction the action returns. ${ARCADE_GATE}`,
].join('\n- ')

const FINISH = 'When done, call `check_guardrails` with the project\'s absolute path and fix every `error` finding.'

function simplePrompt(task: string, specifics: string): GetPromptResult {
  return userMessage([task, '', 'Rules:', `- ${SIMPLE_RULES}`, `- ${BROADCAST_RULES}`, '', specifics, '', FINISH].join('\n'))
}

const FRAMEWORK: Record<'next' | 'express' | 'react' | 'node', string> = {
  next:
    'Next.js: call `createWallet` from `@bsv/simple` only in client components (`\'use client\'`), on a user action, never during server rendering. ' +
    'Import `@bsv/simple/server` only in route handlers and server code. `createServerWalletHandler` denies every route until its `authorize` callback returns `true`: ' +
    'bind it to the authenticated session and check the specific action. Never deploy `authorize: () => true`.',
  express:
    'Express: create the `ServerWallet` from `@bsv/simple/server` once at startup, with `privateKey` from `SERVER_PRIVATE_KEY` in the environment. ' +
    '`createServerWalletHandler` returns Next.js-style handlers; on Express, call the wallet from your own routes behind your own authentication. ' +
    'Decide where wallet records live (`storageUrl`) before mainnet.',
  react:
    'React (browser only): call `createWallet` from `@bsv/simple` in response to a user action, check the wallet\'s network before any money path, ' +
    'and keep every server key out of the bundle. Anything that needs a server wallet belongs in a separate backend.',
  node:
    'Node service or script: use `ServerWallet.create` from `@bsv/simple/server` with `privateKey` from `SERVER_PRIVATE_KEY` in the environment. ' +
    'If you use `ServerWalletManager`, set that variable everywhere and add `.server-wallet.json` to `.gitignore`, because without it the manager writes a generated key there in plain JSON. ' +
    'Decide where wallet records live (`storageUrl`) before mainnet.',
}

const FEATURE: Record<'payments' | 'tokens' | 'inscriptions' | 'messagebox' | 'certificates' | 'did' | 'overlay', string> = {
  payments:
    'Payments: for a payment the app must verify, use `createPaymentRequest` + `sendDirectPayment`, and `receiveDirectPayment` on the recipient side. ' +
    ARCADE_GATE +
    ' `pay()` and `sendMessageBoxPayment` can return an empty or marker txid: never treat either as proof of payment. ' +
    'For ordinary payments omit `basket` so the output lands in the spendable balance (`wallet payment`).',
  tokens:
    'Tokens: `createToken` makes encrypted PushDrop tokens, not 1Color fungible tokens. For 1Color, use the `tokenize_with_1color` prompt instead. ' +
    'Track each token by its outpoint and basket.',
  inscriptions:
    'Inscriptions: use `inscribeText`, `inscribeJSON`, `inscribeFileHash` or `inscribeImageHash` (1 MiB cap, default baskets per method), or `send` with `data` outputs alongside payments.',
  messagebox:
    'MessageBox: delivery is peer to peer through `defaults.messageBoxHost`. A MessageBox payment is not proof of payment, and the identity directory is unauthenticated: ' +
    'treat a tag lookup as a hint and confirm keys independently.',
  certificates:
    'Certificates: issue with `Certifier.create` / `certifier.certify`, or acquire from a remote certifier with `acquireCertificateFrom`. ' +
    '`CredentialIssuer` builds proposed BRC-203 credentials; protect `createCredentialIssuerHandler` with an `authorize` callback bound to the session.',
  did:
    'DID: `getDID()` and `DID.fromIdentityKey` give proposed BRC-202 `did:key` identifiers. Resolution is offline and proves only the key encoding, not control of the key: ' +
    'prove control with a signature or an authenticated session.',
  overlay:
    "Overlay: `Overlay.create` defaults to mainnet, so pass `network: 'testnet'`. Topics start `tm_`. Read the source before relying on `withRetry` or on how `broadcastAction` handles a partial acknowledgement.",
}

/** Registers the five kit prompts. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'review_against_guardrails',
    {
      title: 'Review against guardrails',
      description: 'Run check_guardrails on a project, fix the errors, then walk the manual checklist against bsv://guardrails',
      argsSchema: { path: z.string().describe('Absolute path of the project to review') },
    },
    ({ path }) =>
      userMessage(
        [
          `Review the project at \`${path}\` against the BSV guardrails.`,
          '',
          `1. Call the \`check_guardrails\` tool with \`path\` set to \`${path}\`. The path must be absolute: if it is relative, resolve it against the project root and pass the absolute form.`,
          '2. Fix every finding with severity `error`, then call `check_guardrails` again until none remain. Fix each `warn` too, or say why it does not apply. ' +
            'Suppress a finding with `// bsv-guardrail-ignore G-xx reason` only when the reason is real, and write the reason.',
          '3. Walk the report\'s `manualChecklist` ids one by one: read that rule\'s `## G-xx` section in `bsv://guardrails`, check the code against it, ' +
            'and record pass, fail (with file:line and the fix) or not applicable (with why).',
          '4. Summarize: errors fixed, warnings left and why, and the manual checklist result per id.',
          '',
          '`check_guardrails` is read-only; you make the edits. Never ask for or handle a private key, WIF or seed phrase while reviewing.',
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'tokenize_with_1color',
    {
      title: 'Tokenize with 1Color',
      description: 'Build BRC-162 1Color token outputs (phase 1: encoding guidance only)',
      argsSchema: {
        assetId: z.string().optional().describe('Token id as <txid>_<vout>; not needed to deploy'),
        mode: z.enum(['deploy', 'transfer', 'mint']).describe('What the transaction does'),
      },
    },
    ({ assetId, mode }) => {
      const asset = assetId ? `token \`${assetId}\`` : 'the token (ask the user for its id, `<txid>_<vout>`, if it is not known)'
      const steps: Record<typeof mode, string> = {
        deploy:
          'Deploy: the deploy output must be output 0, with an empty token id. A fixed supply puts the whole amount there; an authority supply puts amount 0 there as the first minting authority. ' +
          'Optional payload fields `sym`, `icon` and `dec` are display only. The new token id is `<deploy txid>_0`.',
        transfer:
          `Transfer ${asset}: the token's value inputs must cover its value outputs. If outputs exceed inputs the outputs are invalid and the inputs are burned; any surplus input is burned. ` +
          'Key the token by its deploy outpoint, never by symbol.',
        mint:
          `Mint ${asset}: spend a valid authority output (amount 0) of this token; the transaction may then create value outputs without covering inputs. ` +
          'Recreate the authority output if minting must remain possible; minting stops when no authority output remains.',
      }
      return userMessage(
        [
          `Build a 1Color ${mode} transaction.`,
          '',
          'Phase 1 scope: this kit gives encoding guidance only, for building and reading BRC-162 outputs. BRC-207 wallet support is not yet in `@bsv/wallet-toolbox` or BSV Desktop, ' +
            'so do not promise wallet-held 1Color balances. `@bsv/simple`\'s `createToken` makes PushDrop tokens, which are not 1Color.',
          '',
          'Read `bsv://facts/tokens-1color` first, and `bsv://brc/0162` for the full output format.',
          '',
          steps[mode],
          '',
          'Build the token prefix with the `Bsv21Binary` script template from `@bsv/templates`; the rest of the locking script is any valid script (usually P2PKH). ' +
            'Validity is enforced by indexers and overlays, not miners, so a malformed output is silently worthless: check the layout against the facts before broadcasting.',
          '',
          'Rules:',
          "- Build and test with `network: 'testnet'`; mainnet only by explicit configuration.",
          `- ${BROADCAST_RULES}`,
          '- Signing happens in the user\'s BRC-100 wallet (`createAction` / `signAction`) or with the server\'s configured key.',
        ].join('\n'),
      )
    },
  )

  server.registerPrompt(
    'integrate_simple',
    {
      title: 'Integrate @bsv/simple',
      description: 'Add @bsv/simple to a Next.js, Express, React or Node project, testnet first',
      argsSchema: { framework: z.enum(['next', 'express', 'react', 'node']).describe('Target framework') },
    },
    ({ framework }) => simplePrompt(`Integrate \`@bsv/simple\` 0.7 into this ${framework} project.`, FRAMEWORK[framework]),
  )

  server.registerPrompt(
    'add_simple_feature',
    {
      title: 'Add a @bsv/simple feature',
      description: 'Add payments, tokens, inscriptions, MessageBox, certificates, DID or overlay support with @bsv/simple',
      argsSchema: {
        feature: z.enum(['payments', 'tokens', 'inscriptions', 'messagebox', 'certificates', 'did', 'overlay']).describe('Feature to add'),
      },
    },
    ({ feature }) => simplePrompt(`Add ${feature} to this app with \`@bsv/simple\` 0.7.`, FEATURE[feature]),
  )

  server.registerPrompt(
    'debug_simple',
    {
      title: 'Debug @bsv/simple',
      description: 'Diagnose a @bsv/simple problem against the known gotchas',
      argsSchema: { symptom: z.string().describe('What goes wrong') },
    },
    ({ symptom }) =>
      simplePrompt(
        'Debug a `@bsv/simple` 0.7 problem. The symptom, as reported:\n\n' + '> ' + symptom.replace(/\n/g, '\n> '),
        [
          'Check, in order:',
          "1. Network: is `network: 'testnet'` passed everywhere, and is the user's wallet actually on testnet (`getClient().getNetwork({})`)?",
          '2. Each entry in `bsv://simple/gotchas`: does the symptom match one (empty txid from `pay()`, `basket` vs `wallet payment`, 403 from a missing `authorize`, a generated server key)?',
          '3. For a known txid, call `arcade_status` and read `txStatus`, `competingTxs` and `extraInfo`; that answer is the truth for the transaction.',
          'State the cause with evidence before changing code, then make the smallest fix.',
        ].join('\n'),
      ),
  )
}

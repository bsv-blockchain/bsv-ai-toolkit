import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const skillDir = fileURLToPath(new URL('../skills/bsv-dev/', import.meta.url))
const refs = skillDir + 'references/'
const read = (file: string) => readFileSync(refs + file, 'utf8')

const must: Record<string, string[]> = {
  'wallet-brc100.md': ['waitForAuthentication', "WalletClient('auto'", 'babbage.groupPermissions', 'hashToDirectlySign', 'G-01', 'letters, digits and single spaces'],
  'payments-brc29.md': ["'3241645161d8'", 'paymentRemittance', 'forSelf', 'fromHexEF', 'toBinaryAtomic', '10 s'],
  'arcade-0conf.md': ['SEEN_ON_NETWORK', 'competingTxs', '476', 'txn-already-known', 'text/plain', '350 ms'],
  'simple-routing.md': ['0.7', 'network', 'arcadeUrl', 'integrate_simple'],
  'testnet-to-mainnet.md': ['BSV_NETWORK', 'bsvfaucet.com', '24 h', 'network-guard.sh', '476'],
  'common-errors.md': ['Atomic BEEF', 'isAuthenticated', 'FEE_TOO_HIGH', '429', 'fileURLToPath', 'require review'],
  'payment-channels.md': ['0xc3', '0xc2', '476', 'SEEN_ON_NETWORK', 'competingTxs', 'hashToDirectlySign', 'nLockTime', 'BRC-121', 'G-35', 'G-38', 'newest'],
}

describe('authored references', () => {
  for (const [file, needles] of Object.entries(must)) {
    it(`${file} carries its required facts`, () => {
      const t = read(file)
      for (const n of needles) expect(t, n).toContain(n)
      expect(t).toMatch(/^# .+\n\nApplies to: (shape A|shape B|both)/)
      expect(t).toMatch(/^Guardrails: G-\d\d/m)
    })

    it(`${file} keeps code snippets to 12 lines or fewer`, () => {
      const blocks = read(file).match(/^```[^\n]*\n[\s\S]*?^```$/gm) ?? []
      for (const b of blocks) expect(b.split('\n').length - 2, b).toBeLessThanOrEqual(12)
    })

    it(`${file} never recommends MINED as the gate`, () => {
      for (const line of read(file).split('\n').filter((l) => l.includes('MINED'))) expect(line).toMatch(/never|not /i)
    })
  }
})

describe('fund-safety wording', () => {
  it('calls a double spend a failed payment only once the two-read rule confirms it', () => {
    for (const file of ['arcade-0conf.md', 'threat-model.md']) {
      const lines = read(file).split('\n').filter((l) => l.includes('failed payment'))
      expect(lines.length, file).toBeGreaterThan(0)
      for (const l of lines) expect(l, file).toMatch(/two-read/)
    }
  })

  it('write-ahead remittance persists the output index and the sender identity key', () => {
    const t = read('payments-brc29.md')
    const call = t.slice(t.indexOf('saveRemittance('), t.indexOf('})', t.indexOf('saveRemittance(')))
    for (const n of ['prefix', 'suffix', 'recipient', 'satoshis', 'outputIndex', 'senderIdentityKey']) expect(call, n).toContain(n)
  })

  it('WhatsOnChain backoff never moves the gate earlier than queued reservations', () => {
    expect(read('arcade-0conf.md')).toContain('next = Math.max(next, Date.now() + 2_000 * 2 ** attempt)')
  })
})

describe('SKILL.md links the authored references', () => {
  const skill = readFileSync(skillDir + 'SKILL.md', 'utf8')

  it('points default decision 4 (finality) at arcade-0conf.md', () => {
    const d4 = skill.split('\n').find((l) => l.startsWith('4. '))!
    expect(d4).toContain('references/arcade-0conf.md')
  })

  it('keeps testnet keys out of the repository and gives a gate script one approval', () => {
    expect(skill).toMatch(/seed held outside the repository/)
    expect(skill).toMatch(/one approval for its whole run/)
  })
})

describe('routing and operations references', () => {
  const sections: Record<string, string[]> = {
    'simple-routing.md': ['What @bsv/simple 0.7 covers', 'What it does not', 'Traps', 'When to drop to @bsv/sdk', 'Shape B recommendation', 'Prompts in @bsv/mcp'],
    'testnet-to-mainnet.md': ['One variable', 'Faucet', 'Fee reality', 'Mainnet checklist', 'On 429 / 476 / FEE_TOO_HIGH'],
    'payment-channels.md': ['When a channel is worth it', 'What works today', 'Three constructions', 'Open', 'Update', 'Close, cooperative', 'Close without the counterparty', 'Stale states and disputes', 'Backups', 'Rúnar for the covenant', 'Arcade for the open and the close', 'Review checklist'],
  }
  for (const [file, heads] of Object.entries(sections)) {
    it(`${file} has its sections`, () => {
      const t = read(file)
      for (const h of heads) expect(t, h).toContain(`\n## ${h}\n`)
    })
  }

  it('payment-channels.md never relies on replacement', () => {
    const lines = read('payment-channels.md').split('\n').filter((l) => /replace/i.test(l))
    for (const l of lines) expect(l).toMatch(/no |never|not |cannot|without/i)
  })

  it('simple-routing.md states the wallet-toolbox Arcade caveat and the network spellings', () => {
    const t = read('simple-routing.md')
    for (const n of ['GorillaPool', 'Taal', 'arcUrl', 'arcGorillaPoolUrl', 'Bitails', 'WhatsOnChain first', 'GET /tx/{txid}', 'Setup.createWalletSQLite', 'go-wallet-toolbox']) expect(t, n).toContain(n)
    expect(t).toMatch(/'testnet' \| 'main'/)
    expect(t).toMatch(/'testnet' \| 'mainnet'/)
    for (const p of ['add_simple_feature', 'debug_simple']) expect(t, p).toContain(p)
  })

  it('testnet-to-mainnet.md keeps the agent broadcast flag out of apps', () => {
    const t = read('testnet-to-mainnet.md')
    const flagLines = t.split('\n').filter((l) => l.includes('BSV_MCP_ALLOW_MAINNET_BROADCAST'))
    expect(flagLines.length).toBeGreaterThan(0)
    for (const l of flagLines) expect(l).toMatch(/agent|arcade_submit/)
    expect(t).toContain('10M sats')
  })

  it('common-errors.md is a symptom, cause, fix table covering the known errors', () => {
    const t = read('common-errors.md')
    expect(t).toContain('| symptom | cause | fix |')
    for (const n of ['WERR_INVALID_PARAMETER', 'Invalid isAuthenticated result', '466', '465', '461', '460', 'UTXO_SPENT', 'Undelayed createAction or signAction results require review', 'mainnet broadcast disabled; set BSV_MCP_ALLOW_MAINNET_BROADCAST=1']) expect(t, n).toContain(n)
    expect(t).toMatch(/404.*wallet/i)
  })
})

describe('fix round 1: network evidence, wallet review errors, fee wording', () => {
  it('network-guard is described as checking only its own environment, with the same check in app code', () => {
    const t = read('testnet-to-mainnet.md')
    expect(t).toMatch(/only the environment it runs in/)
    expect(t).toMatch(/derived from `BSV_NETWORK` at build time/)
    expect(t).toMatch(/startup check/)
    const evidence = t.split('\n').find((l) => l.includes('set on purpose') && l.startsWith('- [ ]'))!
    expect(evidence).toMatch(/startup check/)
    expect(evidence).not.toMatch(/network-guard/)
  })

  it('WERR_REVIEW_ACTIONS row is marked untested and handles an absent tx', () => {
    const row = read('common-errors.md').split('\n').find((l) => l.includes('WERR_REVIEW_ACTIONS'))!
    for (const n of ['not yet tested against BSV Desktop', 'Transaction.fromAtomicBEEF(tx).toHexEF()', 'absent', 'one testnet observation']) expect(row, n).toContain(n)
  })

  it('fees are sized at the configured rate, never below what GET /policy reports', () => {
    for (const file of ['testnet-to-mainnet.md', 'common-errors.md']) {
      const t = read(file)
      expect(t, file).toContain('never below what `GET /policy` reports')
      expect(t, file).not.toMatch(/at the (current )?`?(GET )?\/policy`? rate|at the rate `GET \/policy` reports/)
    }
  })

  it('the wallet-toolbox snippet falls back to the public Arcade when ARCADE_URL is empty', () => {
    expect(read('simple-routing.md')).toMatch(/options\.arcadeUrl = ARCADE_URL \|\|/)
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const skillDir = fileURLToPath(new URL('../skills/bsv-dev/', import.meta.url))
const refs = skillDir + 'references/'
const read = (file: string) => readFileSync(refs + file, 'utf8')

const must: Record<string, string[]> = {
  'wallet-brc100.md': ['waitForAuthentication', "WalletClient('auto'", 'babbage.groupPermissions', 'hashToDirectlySign', 'G-01'],
  'payments-brc29.md': ["'3241645161d8'", 'paymentRemittance', 'forSelf', 'fromHexEF', 'toBinaryAtomic', '10 s'],
  'arcade-0conf.md': ['SEEN_ON_NETWORK', 'competingTxs', '476', 'txn-already-known', 'text/plain', '350 ms'],
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

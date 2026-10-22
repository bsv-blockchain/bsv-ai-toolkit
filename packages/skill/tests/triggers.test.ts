import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { corpus } from './triggers.corpus.ts'
import { extractTriggers, matches } from './matcher.ts'

const skill = readFileSync(fileURLToPath(new URL('../skills/bsv-dev/SKILL.md', import.meta.url)), 'utf8')
const description = skill.match(/^description: '([\s\S]*?)'$/m)![1]
const triggers = extractTriggers(description)

describe('trigger extraction', () => {
  it('reads every quoted phrase, both slash forms and the parenthesised error tokens', () => {
    for (const t of ['build a BSV app', 'send a BSV payment', 'receive a BSV payment', '@bsv/simple', 'wallet-toolbox'])
      expect(triggers).toContain(t)
    for (const t of ['WERR_INVALID_PARAMETER', 'FEE_TOO_HIGH', '476', '429', 'isAuthenticated']) expect(triggers).toContain(t)
    expect(triggers).not.toContain('send/receive a BSV payment')
  })
})

describe('trigger corpus', () => {
  it('every corpus row matches its expectation', () => {
    const wrong = corpus.filter((r) => matches(r.prompt, triggers) !== (r.expect === 'activate'))
    expect(wrong.map((r) => `${r.expect}: ${r.prompt}`)).toEqual([])
  })

  it('corpus has at least 60 rows with 30+ each', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(60)
    expect(corpus.filter((r) => r.expect === 'activate').length).toBeGreaterThanOrEqual(30)
    expect(corpus.filter((r) => r.expect === 'ignore').length).toBeGreaterThanOrEqual(30)
    expect(new Set(corpus.map((r) => r.prompt)).size).toBe(corpus.length)
  })

  it('solana prompts are ignored even with bsv noise', () => {
    for (const p of [
      "my BSV app is written in Solana's Anchor, port it to Solana",
      'build a BSV app on Solana',
      'rewrite the escrow on BSV for Solana: deploy it to Solana devnet',
      'get a Solana testnet faucet airdrop',
    ])
      expect(matches(p, triggers), p).toBe(false)
  })

  it('numeric error codes need a BSV service beside them', () => {
    expect(matches('Arcade answered 476', triggers)).toBe(true)
    expect(matches('explain HTTP 429 in nginx', triggers)).toBe(false)
    expect(matches('order 4760 shipped from Arcade Street', triggers)).toBe(false)
  })
})

// Asks the claude CLI, as a judge, whether it would load the skill for each prompt. Opt-in: BSV_SKILL_JUDGE=1.
describe.skipIf(!process.env.BSV_SKILL_JUDGE)('trigger judge', () => {
  it('claude -p agrees with every corpus row', () => {
    const wrong = corpus.filter((r) => {
      const question = [
        'A coding agent has one skill available. Its description:',
        description,
        `The user says: "${r.prompt}"`,
        'Would the agent load this skill for that request? Answer with exactly YES or NO.',
      ].join('\n\n')
      const answer = execFileSync('claude', ['-p', question], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
      return /\bYES\b/i.test(answer) !== (r.expect === 'activate')
    })
    expect(wrong.map((r) => `${r.expect}: ${r.prompt}`)).toEqual([])
  }, 3_600_000)
})

// A deterministic stand-in for an agent deciding whether to load the bsv-dev skill from its description.
// It reads the trigger phrases out of the description itself, so the corpus tests the description, not a copy.

const NUMERIC = /^\d+$/
// A numeric error code (Arcade 476, WhatsOnChain 429) counts only beside a BSV service in the same prompt;
// on its own, 429 is any rate limit.
const BSV_SERVICE = /\b(arc|arcade|whatsonchain|woc|bsv|txid)\b/
// Another chain named as the target ("to Solana", "on Polygon") means the work is not BSV work.
const OTHER_CHAIN =
  'solana|ethereum|eth|sepolia|polygon|avalanche|cardano|tron|arbitrum|optimism|aptos|sui|metamask|solidity|hardhat|evm|lightning'
const TARGETS_OTHER_CHAIN = new RegExp(`\\b(on|to|onto|for)\\s+(${OTHER_CHAIN})\\b`)
const MENTIONS_OTHER_CHAIN = new RegExp(`\\b(${OTHER_CHAIN})\\b`)
const MENTIONS_BSV = /\b(bsv|brc-\d+|arcade|whatsonchain)\b/
// Words dropped when a multi-word phrase is matched loosely: "build a BSV app" also covers "add a BSV tip
// button to my React app" (keywords bsv + app), but "go to mainnet" stays exact (one keyword is too loose).
const STOPWORDS = new Set(['a', 'an', 'the', 'on', 'with', 'to', 'for', 'of'])
const LEADING_VERBS = new Set(['build', 'connect', 'send', 'receive', 'write', 'go', 'broadcast'])

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const words = (s: string) => s.split(/[^a-z0-9@/_-]+/).filter(Boolean)

/** Every "quoted" phrase in the description (slash alternatives split into both forms) plus the
 *  comma-separated tokens inside its parentheses. */
export function extractTriggers(description: string): string[] {
  const out: string[] = []
  for (const [, phrase] of description.matchAll(/"([^"]+)"/g)) {
    const alt = phrase.match(/^(\w+)\/(\w+)(\s.*)$/)
    if (alt) out.push(alt[1] + alt[3], alt[2] + alt[3])
    else out.push(phrase)
  }
  for (const [, group] of description.matchAll(/\(([^()]+)\)/g)) {
    out.push(...group.split(',').map((t) => t.trim()).filter(Boolean))
  }
  return [...new Set(out)]
}

function keywords(trigger: string): string[] | undefined {
  const ws = words(normalize(trigger)).filter((w) => !STOPWORDS.has(w))
  if (LEADING_VERBS.has(ws[0])) ws.shift()
  return ws.length >= 2 ? ws : undefined
}

const hasWord = (promptWords: string[], kw: string) =>
  promptWords.some((w) => w === kw || w === kw + 's' || w === kw + 'es')

/** Whether an agent reading the description would load the skill for this prompt. */
export function matches(prompt: string, triggers: string[]): boolean {
  const p = normalize(prompt)
  if (TARGETS_OTHER_CHAIN.test(p)) return false
  if (MENTIONS_OTHER_CHAIN.test(p) && !MENTIONS_BSV.test(p)) return false
  const promptWords = words(p)
  return triggers.some((trigger) => {
    const t = normalize(trigger)
    if (NUMERIC.test(t)) return new RegExp(`\\b${t}\\b`).test(p) && BSV_SERVICE.test(p)
    if (p.includes(t)) return true
    const kws = keywords(trigger)
    return kws !== undefined && kws.every((kw) => hasWord(promptWords, kw))
  })
}

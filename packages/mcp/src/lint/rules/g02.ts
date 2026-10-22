import type { Rule, RuleResult } from './index.js'
import { isSource, lineAt, matchingLines } from './util.js'

// A name that is, or ends in, network / chain / net (`network`, `defaultNetwork`, `BSV_NETWORK`, `chain`).
const NAME = String.raw`\b(?:\w*[a-z0-9](?:Network|Chain|Net)|\w*_(?:network|chain|net|NETWORK|CHAIN|NET)|[Nn]etwork|[Cc]hain|[Nn]et|NETWORK|CHAIN|NET)\b['"]?`
// `=` (assignment, parameter or destructuring default), directly or behind a `??` / `||` fallback.
const ASSIGN = String.raw`(?::\s*[\w.<>\[\]| ]+?)?=(?![=>])\s*(?:[^;={}]*?(?:\?\?|\|\|)\s*)?`
// `:` (object key) only behind a fallback: `network: 'mainnet'` in an explicit per-network table is fine.
const KEY_FALLBACK = String.raw`:\s*[^;=,:{}]*?(?:\?\?|\|\|)\s*`
const MAIN = String.raw`['"\`](?:main|mainnet)['"\`]\s*(?:[,;})\]]|\/\/|$)`
/** A hardcoded mainnet default. Comparisons, union types and explicit config tables do not match. */
export const MAINNET_DEFAULT = new RegExp(String.raw`${NAME}\s*(?:${ASSIGN}|${KEY_FALLBACK})${MAIN}`)
const CREATE_ACTION = /\bcreateAction\s*\(/
const GET_NETWORK = /\bgetNetwork\s*\(/

/**
 * G-02: no hardcoded mainnet default (both shapes); and in a browser-wallet project (A, A+B) that calls
 * `createAction`, some file reads `getNetwork()`. Shape B reads the server wallet's chain instead.
 */
export const g02: Rule = {
  id: 'G-02',
  run({ files, shape, meta }) {
    const findings: RuleResult['findings'] = []
    const source = files.filter(isSource)
    for (const f of source) {
      for (const m of matchingLines(f.text, MAINNET_DEFAULT)) {
        findings.push({ id: meta.id, severity: meta.severity, file: f.rel, line: m.line, snippet: m.text })
      }
    }

    const spender = shape === 'A' || shape === 'A+B' ? source.find(f => CREATE_ACTION.test(f.text)) : undefined
    if (spender && !source.some(f => GET_NETWORK.test(f.text))) {
      const line = lineAt(spender.text, spender.text.search(CREATE_ACTION))
      findings.push({
        id: meta.id,
        severity: meta.severity,
        file: spender.rel,
        line,
        snippet: `${spender.text.split('\n')[line - 1].trim()} (no getNetwork() call anywhere in the project)`,
      })
    }
    return { findings, applicable: true }
  },
}

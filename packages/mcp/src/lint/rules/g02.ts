import type { Rule, RuleResult } from './index.js'
import { isSource, lineAt, matchingLines } from './util.js'

// A name containing network/chain, a single `=` or `:`, then 'main'/'mainnet' either directly or as a
// `??` / `||` fallback, ending the expression. Comparisons (`===`) and union types (`'mainnet' | ...`) do not match.
const MAINNET_DEFAULT =
  /\b\w*(?:network|chain)\w*['"]?\s*(?:=(?![=>])|:)\s*(?:[^;=]*?(?:\?\?|\|\|)\s*)?['"`](?:main|mainnet)['"`]\s*(?:[,;})\]]|\/\/|$)/i
const CREATE_ACTION = /\bcreateAction\s*\(/
const GET_NETWORK = /\bgetNetwork\s*\(/

/** G-02: no hardcoded mainnet default, and a project that calls `createAction` reads `getNetwork()`. */
export const g02: Rule = {
  id: 'G-02',
  run({ files, meta }) {
    const findings: RuleResult['findings'] = []
    const source = files.filter(isSource)
    for (const f of source) {
      for (const m of matchingLines(f.text, MAINNET_DEFAULT)) {
        findings.push({ id: meta.id, severity: meta.severity, file: f.rel, line: m.line, snippet: m.text })
      }
    }

    const spender = source.find(f => CREATE_ACTION.test(f.text))
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

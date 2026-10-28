import type { Rule, RuleResult } from './index.js'
import { isSource, matchingLines } from './util.js'

const IS_AUTHENTICATED = /\.isAuthenticated\s*\(/

/** G-01: client code must gate on `waitForAuthentication()`, never `isAuthenticated()`. */
export const g01: Rule = {
  id: 'G-01',
  run({ files, meta }) {
    const findings: RuleResult['findings'] = []
    for (const f of files.filter(f => f.isClient && isSource(f))) {
      for (const m of matchingLines(f.text, IS_AUTHENTICATED)) {
        findings.push({ id: meta.id, severity: meta.severity, file: f.rel, line: m.line, snippet: m.text })
      }
    }
    return { findings, applicable: true }
  },
}

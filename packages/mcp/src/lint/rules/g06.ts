import { basename } from 'node:path'
import type { Rule, RuleResult } from './index.js'
import { isSource, matchingLines } from './util.js'

const CLIENT_KEY = /\bPrivateKey\.(?:fromRandom|fromHex|fromWif|fromString)\s*\(/
const ENV_SECRET = /^(?!\s*#).*(KEY|SECRET|WIF|MNEMONIC)\s*=\s*\S{32,}/

// Snippets land in reports and logs, so never echo a secret: long literals and env values are redacted.
const redactLiterals = (line: string) => line.replace(/(['"`])[^'"`]{32,}\1/g, "'<redacted>'")
const redactEnv = (line: string) => line.replace(/=.*$/, '=<redacted>')

/** G-06: no private key in client code, and no committed `.env` holding a key or secret. */
export const g06: Rule = {
  id: 'G-06',
  run({ files, meta }) {
    const findings: RuleResult['findings'] = []
    const push = (file: string, line: number, snippet: string) => findings.push({ id: meta.id, severity: meta.severity, file, line, snippet })
    for (const f of files) {
      if (f.isClient && isSource(f)) {
        for (const m of matchingLines(f.text, CLIENT_KEY)) push(f.rel, m.line, redactLiterals(m.text))
      } else if (basename(f.rel) === '.env') {
        for (const m of matchingLines(f.text, ENV_SECRET)) push(f.rel, m.line, redactEnv(m.text))
      }
    }
    return { findings, applicable: true }
  },
}

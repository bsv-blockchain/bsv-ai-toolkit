import { basename } from 'node:path'
import type { Rule, RuleResult } from './index.js'
import { isSource, matchingLines } from './util.js'

const CLIENT_KEY = /\bPrivateKey\.(?:fromRandom|fromHex|fromWif|fromString)\s*\(/
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
const SECRET_NAME = /KEY|SECRET|WIF|MNEMONIC|SEED/
const PHRASE_NAME = /MNEMONIC|SEED/
const COMPRESSED_PUBKEY = /^["']?0[23][0-9a-f]{64}["']?$/i

/** True when a `.env` line holds a private key, secret or seed phrase (public keys excluded). */
export function isEnvSecret(line: string): boolean {
  const m = ENV_LINE.exec(line)
  if (!m || line.trimStart().startsWith('#')) return false
  const [, name, raw] = m
  const value = raw.trim()
  if (/PUB/i.test(name) || !SECRET_NAME.test(name) || COMPRESSED_PUBKEY.test(value)) return false
  if (PHRASE_NAME.test(name) && value.replace(/^["']|["']$/g, '').trim().split(/\s+/).length >= 12) return true
  return /^\S{32,}/.test(value)
}

// Snippets land in reports and logs, so never echo a secret: long literals and env values are redacted.
const redactLiterals = (line: string) => line.replace(/(['"`])[^'"`]{32,}\1/g, "'<redacted>'")
const redactEnv = (line: string) => line.replace(/=.*$/, '=<redacted>')

/**
 * G-06: no private key in client code (skipped for a pure shape-B project, whose server holds its root key),
 * and no committed `.env` holding a key, secret or seed phrase.
 */
export const g06: Rule = {
  id: 'G-06',
  run({ files, shape, meta }) {
    const findings: RuleResult['findings'] = []
    const push = (file: string, line: number, snippet: string) => findings.push({ id: meta.id, severity: meta.severity, file, line, snippet })
    for (const f of files) {
      if (basename(f.rel) === '.env') {
        f.text.split(/\r?\n/).forEach((t, i) => { if (isEnvSecret(t)) push(f.rel, i + 1, redactEnv(t.trim())) })
      } else if (shape !== 'B' && f.isClient && isSource(f)) {
        for (const m of matchingLines(f.text, CLIENT_KEY)) push(f.rel, m.line, redactLiterals(m.text))
      }
    }
    return { findings, applicable: true }
  },
}

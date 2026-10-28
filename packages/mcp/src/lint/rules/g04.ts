import type { Rule, RuleResult } from './index.js'
import { findManifests, lineAt, parseJson } from './util.js'

const MAX_ALLOWANCE = 100_000
const LEVEL2 = /"protocolID"\s*:\s*\[\s*2\s*[,\]]/g
const SPENDING = /"spendingAuthorization"\s*:/g

type Entry = Record<string, unknown>

/** Every object under a `key` property, in document (text) order. */
function collect(node: unknown, key: string, out: Entry[] = []): Entry[] {
  if (Array.isArray(node)) for (const v of node) collect(v, key, out)
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) (Array.isArray(v) ? v : [v]).forEach(e => e && typeof e === 'object' && out.push(e as Entry))
      collect(v, key, out)
    }
  }
  return out
}

/** Line of the n-th match of `re` in `text` (1 when there is no such match). */
function nthLine(text: string, re: RegExp, n: number): number {
  const m = [...text.matchAll(re)][n]
  return m?.index === undefined ? 1 : lineAt(text, m.index)
}

/** G-04 (shape A): level-2 manifest protocols name a `counterparty`; the spending allowance stays small. */
export const g04: Rule = {
  id: 'G-04',
  run({ files, shape, meta }) {
    if (shape !== 'A' && shape !== 'A+B') return { findings: [], applicable: false }
    const findings: RuleResult['findings'] = []
    for (const f of findManifests(files)) {
      const json = parseJson(f.text)
      if (!json) continue // G-03 reports invalid JSON
      const push = (line: number, snippet: string) => findings.push({ id: meta.id, severity: meta.severity, file: f.rel, line, snippet })

      // JSON.parse keeps text order for these keys, so the n-th level-2 entry is the n-th LEVEL2 match.
      const level2 = collect(json, 'protocolPermissions').filter(e => Array.isArray(e.protocolID) && e.protocolID[0] === 2)
      level2.forEach((e, n) => {
        if (e.counterparty === undefined) {
          push(nthLine(f.text, LEVEL2, n), `level-2 protocol ${JSON.stringify(e.protocolID)} has no counterparty`)
        }
      })
      collect(json, 'spendingAuthorization').forEach((s, n) => {
        if (typeof s.amount === 'number' && s.amount > MAX_ALLOWANCE) {
          push(nthLine(f.text, SPENDING, n), `spendingAuthorization.amount ${s.amount} exceeds ${MAX_ALLOWANCE}`)
        }
      })
    }
    return { findings, applicable: true }
  },
}

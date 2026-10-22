import type { Rule } from './index.js'
import { bracketText, closeOf, findingList, isSource, lineAt, scan } from './util.js'

const INTERNALIZE = /(?:\.|\?\.)\s*internalizeAction\s*\(/g
const WALLET_PAYMENT = /['"`]wallet payment['"`]/g
const BASKET = /basketInsertion|insertionRemittance|['"`]basket insertion['"`]/

/** Offset of the `{` that encloses `index` in `masked`, or -1. */
function enclosingBrace(masked: string, index: number): number {
  let depth = 0
  for (let i = index; i >= 0; i--) {
    const c = masked[i]
    if (c === '}' || c === ')' || c === ']') depth++
    else if (c === '(' || c === '[') depth--
    else if (c === '{') { if (depth === 0) return i; depth-- }
    if (depth < 0) depth = 0
  }
  return -1
}

/**
 * G-21: BRC-29 payments are internalized with `paymentRemittance`. Flags `.internalizeAction(` whose
 * arguments (up to 30 lines) have no `paymentRemittance` (basket-insertion-only calls pass; outputs passed
 * as a variable count only when the module builds a `wallet payment` without one), and an output that is
 * both a `wallet payment` and a basket insertion.
 */
export const g21: Rule = {
  id: 'G-21',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      for (const m of s.masked.matchAll(INTERNALIZE)) {
        const args = bracketText(s, m.index + m[0].length - 1, 30).code
        // Outputs passed as a variable: judge by the module, and only when it builds a wallet payment.
        const inline = /\bprotocol\b/.test(args)
        const text = inline ? args : s.code
        if (/paymentRemittance/.test(text)) continue
        if (inline ? !/wallet payment/.test(text) && BASKET.test(text) : !/wallet payment/.test(text)) continue
        const line = lineAt(s.text, m.index + m[0].indexOf('internalizeAction'))
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (no paymentRemittance)`)
      }
      for (const m of s.code.matchAll(WALLET_PAYMENT)) {
        const open = enclosingBrace(s.masked, m.index)
        const close = open < 0 ? -1 : closeOf(s.masked, open)
        if (close < 0 || !BASKET.test(s.code.slice(open, close))) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (wallet payment and basket insertion on one output)`)
      }
    }
    return { findings: out.findings, applicable: true }
  },
}

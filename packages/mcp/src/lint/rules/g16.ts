import type { Rule } from './index.js'
import { bracketText, findingList, inLoop, isSource, lineAt, scan } from './util.js'

const FROM_HEX = /\bTransaction\.fromHex\s*\(/g
const TX_HEX = /\/tx\/.*\/hex\b/

/**
 * G-16: Arcade's `rawTx` is Extended Format. Flags `Transaction.fromHex(…rawTx…)` unless the argument
 * goes through `fromHexEF`, and a `/tx/{txid}/hex` fetch inside a loop (ancestry built one tx at a time).
 */
export const g16: Rule = {
  id: 'G-16',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      for (const m of s.masked.matchAll(FROM_HEX)) {
        const arg = bracketText(s, m.index + m[0].length - 1, 5).code
        if (!/rawTx/i.test(arg) || /fromHexEF/.test(arg)) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, s.lines[line - 1].trim())
      }
      s.codeLines.forEach((t, i) => {
        const hex = TX_HEX.exec(t)
        if (hex && inLoop(s, s.starts[i] + hex.index)) out.add(f.rel, i + 1, `${s.lines[i].trim()} (one ancestor at a time, in a loop)`)
      })
    }
    out.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    return { findings: out.findings, applicable: true }
  },
}

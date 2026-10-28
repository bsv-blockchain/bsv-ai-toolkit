import type { Rule } from './index.js'
import { bracketText, findingList, isSource, lineAt, scan, withAliases } from './util.js'

const SERVICE = /arcade|whatsonchain|\bwoc/i
const FETCH = /\bfetch\s*\(/g
const SIGNAL = /\bsignal\b/
const MAX_CALL_LINES = 60

/** Index of the first top-level comma in masked call arguments, or -1. */
function firstArgEnd(masked: string): number {
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) return i
  }
  return -1
}

/**
 * G-15: a per-request timeout on every Arcade/WhatsOnChain call. Flags `fetch(` whose URL names
 * Arcade or WoC and whose init (the rest of the call) has no `signal`. An init passed as a
 * variable is accepted when the module sets a `signal` somewhere.
 */
export const g15: Rule = {
  id: 'G-15',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      const service = withAliases(s.code, SERVICE)
      for (const m of s.masked.matchAll(FETCH)) {
        // The whole call, to its closing bracket: Prettier can put `signal` many lines down.
        const args = bracketText(s, m.index + m[0].length - 1, MAX_CALL_LINES)
        const comma = firstArgEnd(args.masked)
        const url = comma < 0 ? args.code : args.code.slice(0, comma)
        if (!service.test(url)) continue
        const init = comma < 0 ? '' : args.code.slice(comma + 1)
        if (SIGNAL.test(init)) continue
        if (/^\s*[\w$.]+\s*$/.test(init) && SIGNAL.test(s.code)) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, s.lines[line - 1].trim())
      }
    }
    return { findings: out.findings, applicable: true }
  },
}

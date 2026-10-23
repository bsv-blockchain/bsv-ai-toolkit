import type { Rule } from './index.js'
import { bracketText, closeOf, findingList, isSource, lineAt, scan, type Scan } from './util.js'

// `lockTime`, `nLockTime`, `lockTimeBase`, `locktime` (any case), as a whole identifier.
const LOCK_NAME = /(?<![\w$])n?locktime(?:base)?(?![\w$])/gi
const MS_CLOCK = /\bDate\.now\s*\(\s*\)|\.getTime\s*\(\s*\)|\bperformance\.now\s*\(\s*\)/
// `/ 1000`, `/1_000`, `/ 1e3`; `* 1000` is a conversion of a seconds value to compare with the clock.
const CONVERTED = /[/*]\s*(?:1_?000|1e3)(?![\w.])/
const NEW_TX = /\bnew\s+Transaction\s*\(/g
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])
const CONTINUES = /(?:[=:(+\-*/?|&]|\?\?)\s*$/
const EXTRA_LINES = 3

/**
 * The comment-free text of the item holding offset `at`: back to the line start or the nearest `,` `;` or
 * opener at the same depth, forward to the next `,` `;` or closer at that depth. A newline ends it unless
 * a bracket is still open or the text so far ends with an operator; at most three further lines.
 */
function itemAround(s: Scan, at: number): string {
  const m = s.masked
  let start = at
  for (let depth = 0, i = at - 1; i >= 0 && m[i] !== '\n'; i--) {
    if (CLOSE.has(m[i])) depth++
    else if (OPEN.has(m[i])) { if (depth === 0) break; depth-- }
    else if (depth === 0 && (m[i] === ',' || m[i] === ';')) break
    start = i
  }
  const lastLine = lineAt(s.text, at) + EXTRA_LINES
  const limit = s.starts[lastLine] ?? m.length
  let end = at
  for (let depth = 0; end < limit; end++) {
    const c = m[end]
    if (OPEN.has(c)) depth++
    else if (CLOSE.has(c)) { if (depth === 0) break; depth-- }
    else if (depth === 0 && (c === ',' || c === ';')) break
    else if (depth === 0 && c === '\n' && !CONTINUES.test(m.slice(start, end))) break
  }
  return m.slice(start, end)
}

/** The comment-free text of each top-level argument of the call whose `(` is at `open`. */
function args(s: Scan, open: number): string[] {
  const { masked } = bracketText(s, open, 5)
  const out: string[] = []
  let from = 0
  for (let depth = 0, i = 0; i < masked.length; i++) {
    if (OPEN.has(masked[i])) depth++
    else if (CLOSE.has(masked[i])) depth--
    else if (depth === 0 && masked[i] === ',') { out.push(masked.slice(from, i)); from = i + 1 }
  }
  out.push(masked.slice(from))
  return out
}

const unconverted = (text: string) => MS_CLOCK.test(text) && !CONVERTED.test(text)

/**
 * G-36: lock times in seconds or heights. Flags a lock-time name whose statement reads a millisecond clock
 * (`Date.now()`, `.getTime()`, `performance.now()`) with no `/ 1000`, and `new Transaction(…)` whose fourth
 * argument (the lock time) does the same. Not applicable when no source file names a lock time.
 */
export const g36: Rule = {
  id: 'G-36',
  run({ files, meta }) {
    const out = findingList(meta)
    let mentions = false
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      for (const m of s.masked.matchAll(LOCK_NAME)) {
        mentions = true
        if (!unconverted(itemAround(s, m.index))) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (milliseconds clock in a lock time; divide by 1000)`)
      }
      for (const m of s.masked.matchAll(NEW_TX)) {
        const open = m.index + m[0].length - 1
        if (closeOf(s.masked, open) < 0) continue
        const lockTime = args(s, open)[3]
        if (lockTime === undefined || !unconverted(lockTime)) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (milliseconds clock as the nLockTime argument; divide by 1000)`)
      }
    }
    return { findings: out.findings, applicable: mentions || out.findings.length > 0 }
  },
}

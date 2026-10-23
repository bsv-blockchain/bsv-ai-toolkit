import type { Rule } from './index.js'
import { bracketText, closeOf, enclosingOpens, findingList, isSource, lineAt, scan, type Scan } from './util.js'

// `lockTime`, `nLockTime`, `lockTimeBase`, `locktime` (any case), as a whole identifier.
const LOCK_NAME = /(?<![\w$])n?locktime(?:base)?(?![\w$])/gi
const MS_CLOCK = /\bDate\.now\s*\(\s*\)|\.getTime\s*\(\s*\)|\bperformance\.now\s*\(\s*\)/g
// `/ 1000`, `/1_000`, `/ 1e3`, or BigInt `/ 1000n`.
const DIVIDED = /^\s*\/\s*(?:1_?000n?|1e3)(?![\w.])/
const INTEGER = /\bMath\.(?:floor|trunc|round|ceil)\s*\(|\|\s*0(?![\w.])|>>>\s*0(?![\w.])|~~/
const TIMES_1000 = /^\s*\*\s*(?:1_?000|1e3)(?![\w.])/
const COMPARISON = /[<>]=?|[!=]==?/
const NEW_TX = /\bnew\s+Transaction\s*\(/g
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])
// A line that ends with one of these, or a next line that starts with one, continues the expression.
const ENDS_OPEN = /(?:[=:(+\-*/?|&%]|\?\?)\s*$/
const STARTS_CONT = /^\s*(?:[?:.+\-*/|&%]|\?\?)/
const EXTRA_LINES = 3

/** Top-level `?` / `:` branches of an expression; the condition of a ternary is dropped. */
function branches(expr: string): string[] {
  const parts: string[] = []
  let from = 0
  let ternary = false
  for (let depth = 0, i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (OPEN.has(c)) depth++
    else if (CLOSE.has(c)) depth--
    else if (depth === 0 && (c === '?' || c === ':') && expr[i + 1] !== '?' && expr[i + 1] !== '.' && expr[i - 1] !== '?') {
      ternary ||= c === '?'
      parts.push(expr.slice(from, i))
      from = i + 1
    }
  }
  parts.push(expr.slice(from))
  return ternary ? parts.slice(1) : parts
}

/**
 * How the clock at `at` in `part` is converted to seconds: `'integer'` (a `…sec…` helper wraps it, or a
 * BigInt division by `1000n`), `'divided'` (a plain `/ 1000` on the clock or on a bare group around it), or
 * undefined when it stays in milliseconds.
 */
function conversion(part: string, at: number, clockEnd: number): 'integer' | 'divided' | undefined {
  if (DIVIDED.test(part.slice(clockEnd))) return 'divided'
  for (const open of enclosingOpens(part, at, false).filter(o => part[o] === '(')) {
    const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(part.slice(0, open))?.[1]
    if (callee && /sec/i.test(callee)) return 'integer'
    if (callee && callee !== 'BigInt') continue
    const close = closeOf(part, open)
    const divided = close < 0 ? null : DIVIDED.exec(part.slice(close + 1))
    if (divided) return divided[0].trimEnd().endsWith('n') ? 'integer' : 'divided'
  }
  return undefined
}

/** True when a value assigned as a lock time reads a millisecond clock unconverted, or yields float seconds. */
function badLockTime(expr: string): boolean {
  for (const part of branches(expr)) {
    let needsInteger = false
    for (const m of part.matchAll(MS_CLOCK)) {
      const how = conversion(part, m.index, m.index + m[0].length)
      if (!how) return true
      needsInteger ||= how === 'divided'
    }
    if (needsInteger && !INTEGER.test(part)) return true
  }
  return false
}

/** The assigned expression starting at `from`, ending at a depth-0 `,` `;` or closer, continued across lines. */
function valueFrom(s: Scan, from: number): string {
  const m = s.masked
  const limit = s.starts[lineAt(s.text, from) + EXTRA_LINES] ?? m.length
  let end = from
  for (let depth = 0; end < limit; end++) {
    const c = m[end]
    if (OPEN.has(c)) depth++
    else if (CLOSE.has(c)) { if (depth === 0) break; depth-- }
    else if (depth === 0 && (c === ',' || c === ';')) break
    else if (depth === 0 && c === '\n') {
      const soFar = m.slice(from, end)
      const next = m.slice(end + 1).split('\n').find(l => l.trim() !== '') ?? ''
      if (soFar.trim() !== '' && !ENDS_OPEN.test(soFar) && !STARTS_CONT.test(next)) break
    }
  }
  return m.slice(from, end)
}

/** The clause around a read of the name at `at`: bounded by `&&` `||` `?` `:` `,` `;` `=`, a bracket or the line. */
function clauseAround(m: string, at: number, length: number): string {
  const boundary = (i: number) => {
    const c = m[i]
    const pair = m.slice(i - 1, i + 1)
    if (c === ',' || c === ';' || c === '\n' || c === '?' || c === ':') return true
    if (pair === '&&' || pair === '||' || m.slice(i, i + 2) === '&&' || m.slice(i, i + 2) === '||') return true
    return c === '=' && !/[=<>!]/.test(m[i - 1] ?? '') && !/[=>]/.test(m[i + 1] ?? '')
  }
  let start = at
  for (let depth = 0, i = at - 1; i >= 0; i--) {
    if (CLOSE.has(m[i])) depth++
    else if (OPEN.has(m[i])) { if (depth === 0) break; depth-- }
    else if (depth === 0 && boundary(i)) break
    start = i
  }
  let end = at + length
  for (let depth = 0; end < m.length; end++) {
    if (OPEN.has(m[end])) depth++
    else if (CLOSE.has(m[end])) { if (depth === 0) break; depth-- }
    else if (depth === 0 && boundary(end)) break
  }
  return m.slice(start, end)
}

/** A read of a lock time compared or combined with a millisecond clock, unless the lock time is scaled by 1000. */
function badRead(m: string, at: number, name: string): boolean {
  const clause = clauseAround(m, at, name.length)
  const cmp = COMPARISON.exec(clause.replace(/=>/g, '  '))
  const sides = cmp ? [clause.slice(0, cmp.index), clause.slice(cmp.index + cmp[0].length)] : [clause, clause]
  const nameSide = sides.find(side => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(side)) ?? sides[0]
  const other = sides.find(side => side !== nameSide) ?? nameSide
  const clocks = [...other.matchAll(MS_CLOCK)].filter(c => !DIVIDED.test(other.slice(c.index + c[0].length)))
  if (!clocks.length) return false
  const scaled = new RegExp(`(?<![\\w$])${name}(?![\\w$])`).exec(nameSide)
  return !(scaled && (TIMES_1000.test(nameSide.slice(scaled.index + name.length)) || /(?:1_?000|1e3)\s*\*\s*$/.test(nameSide.slice(0, scaled.index))))
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

/**
 * G-36: lock times in seconds or heights. A value assigned to a lock-time name (declaration, assignment,
 * property, or the fourth argument of `new Transaction(…)`) is flagged when it reads a millisecond clock
 * (`Date.now()`, `.getTime()`, `performance.now()`) that is not itself divided by 1000 (or by `1000n` as a
 * BigInt, or wrapped in a helper whose name contains "sec"), or when it is seconds without an integer
 * conversion. A clock stored in a local first (`const now = Date.now()`) is not followed. A lock time compared with a millisecond clock is flagged unless
 * one side is scaled by 1000. Not applicable when no source file names a lock time.
 */
export const g36: Rule = {
  id: 'G-36',
  run({ files, meta }) {
    const out = findingList(meta)
    let mentions = false
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      const m = s.masked
      for (const hit of m.matchAll(LOCK_NAME)) {
        mentions = true
        const after = m.slice(hit.index + hit[0].length)
        const declared = /\b(?:const|let|var)\s+$/.test(m.slice(Math.max(0, hit.index - 12), hit.index))
        const assign = (declared ? /^\s*(?::[^=;\n]+)?=(?![=>])/ : /^\s*(?::(?!:)|=(?![=>]))/).exec(after)
        const bad = assign
          ? badLockTime(valueFrom(s, hit.index + hit[0].length + assign[0].length))
          : badRead(m, hit.index, hit[0])
        if (!bad) continue
        const line = lineAt(s.text, hit.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (milliseconds clock or float seconds in a lock time; use Math.floor(Date.now() / 1000))`)
      }
      for (const call of m.matchAll(NEW_TX)) {
        const open = call.index + call[0].length - 1
        if (closeOf(m, open) < 0) continue
        const lockTime = args(s, open)[3]
        if (lockTime === undefined || !badLockTime(lockTime)) continue
        const line = lineAt(s.text, call.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (milliseconds clock as the nLockTime argument; use Math.floor(Date.now() / 1000))`)
      }
    }
    return { findings: out.findings, applicable: mentions || out.findings.length > 0 }
  },
}

import type { Rule } from './index.js'
import { findingList, isSource, lineAt, scan, type Scan } from './util.js'

const CREATE_SIGNATURE = /\bcreateSignature\s*\(/
const HASH_KEY = /(?<![\w$])hashToDirectlySign\s*:/g
// A value read from something that arrived over the wire: a message, request, body or parsed JSON.
const WIRE = /(?<![\w$.])(?:msg|message|req|request|body|params|payload)\s*\??\.|(?<![\w$.])event\s*\??\.\s*data\b|(?<![\w$.])data\s*\??\.\s*digest\b|\bJSON\.parse\s*\(|\.json\s*\(\s*\)|\bsearchParams\b/
// A whole parameter-shaped source that a digest may be destructured from: `const { digest } = msg`.
const WIRE_SOURCE = /^\s*(?:await\s+)?(?:msg|message|req|request|payload|event)\s*(?:[;,\n]|$)/
const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)\s*([^\n;]*)/g
const DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=(?!=)\s*([^\n;]*)/g
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])
const MAX_LINES = 5

/** The text after `from` up to the next `,` or closer at depth 0, at most five lines. */
function valueAt(s: Scan, from: number): string {
  const limit = s.starts[lineAt(s.text, from) - 1 + MAX_LINES] ?? s.masked.length
  let end = from
  for (let depth = 0; end < limit; end++) {
    const c = s.masked[end]
    if (OPEN.has(c)) depth++
    else if (CLOSE.has(c)) { if (depth === 0) break; depth-- }
    else if (depth === 0 && (c === ',' || c === ';')) break
  }
  return s.masked.slice(from, end)
}

/** Local names bound to a wire-shaped value, directly, by destructuring, or through other such names. */
function wireNames(masked: string): string[] {
  const names: string[] = []
  const refers = (expr: string) => WIRE.test(expr) || names.some(n => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(expr))
  const decls = [...masked.matchAll(DECL)].map(m => ({ bound: [m[1]], expr: m[2] }))
  for (const m of masked.matchAll(DESTRUCTURE)) {
    const bound = m[1].split(',').map(p => p.split(/[:=]/).at(p.includes(':') ? 1 : 0)!.trim()).filter(n => /^[A-Za-z_$][\w$]*$/.test(n))
    decls.push({ bound, expr: WIRE_SOURCE.test(m[2]) ? 'msg.' : m[2] })
  }
  for (let grew = true; grew;) {
    grew = false
    for (const d of decls) {
      if (!refers(d.expr)) continue
      for (const n of d.bound) if (!names.includes(n)) { names.push(n); grew = true }
    }
  }
  return names
}

/**
 * G-08: sign only digests you rebuilt. Flags `hashToDirectlySign:` whose value is read from a message,
 * request, body, parsed JSON or URL parameters, directly or through a local name bound to one.
 * Not applicable when no source file calls `createSignature(`.
 */
export const g08: Rule = {
  id: 'G-08',
  run({ files, meta }) {
    const out = findingList(meta)
    let applicable = false
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      if (!CREATE_SIGNATURE.test(s.masked)) continue
      applicable = true
      const names = wireNames(s.masked)
      const alias = names.length ? new RegExp(`(?<![\\w$.])(?:${names.map(n => n.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`) : undefined
      for (const m of s.masked.matchAll(HASH_KEY)) {
        const value = valueAt(s, m.index + m[0].length)
        if (!WIRE.test(value) && !alias?.test(value)) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (digest read from the wire; rebuild it yourself)`)
      }
    }
    return { findings: out.findings, applicable }
  },
}

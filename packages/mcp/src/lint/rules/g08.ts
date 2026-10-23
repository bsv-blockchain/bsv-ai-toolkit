import type { Rule } from './index.js'
import { closeOf, findingList, isSource, lineAt, scan, type Scan } from './util.js'

const CREATE_SIGNATURE = /\bcreateSignature\s*\(/
const HASH_KEY = /(?<![\w$])hashToDirectlySign\s*:/g
// Roots of a value that arrived over the wire, when read through a property (`msg.digest`).
const WIRE_ROOTS = new Set(['msg', 'message', 'req', 'request', 'body', 'params', 'payload'])
// Whole parameter-shaped sources a digest may be destructured from: `const { digest } = msg`.
const WIRE_SOURCES = new Set(['msg', 'message', 'req', 'request', 'payload', 'event'])
// Calls that only change a value's encoding; the wire chain inside them is still the value.
const DECODER = /^(?:Utils\s*\.\s*toArray|Buffer\s*\.\s*from|Uint8Array\s*\.\s*from|hexToBytes|toArray)\s*\(/
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

/** First top-level argument of the call whose `(` is at `open` in `expr`. */
function firstArg(expr: string, open: number): string {
  let depth = 0
  for (let i = open + 1; i < expr.length; i++) {
    if (OPEN.has(expr[i])) depth++
    else if (CLOSE.has(expr[i])) { if (depth === 0) return expr.slice(open + 1, i); depth-- }
    else if (depth === 0 && expr[i] === ',') return expr.slice(open + 1, i)
  }
  return expr.slice(open + 1)
}

/**
 * The member chain an expression *is*, with call arguments and index contents emptied, after dropping
 * `await`, outer parentheses and decoder calls: `Utils.toArray((await res.json()).d, 'hex')` → `res.json().d`.
 * Undefined when the expression is anything else (a builder call, arithmetic, a literal).
 */
function chainOf(expr: string): string | undefined {
  let e = expr.trim().replace(/^await\s+/, '')
  for (;;) {
    const decoder = DECODER.exec(e)
    if (decoder) {
      const open = decoder[0].length - 1
      if (closeOf(e, open) !== e.length - 1) return undefined
      e = firstArg(e, open).trim().replace(/^await\s+/, '')
      continue
    }
    if (e.startsWith('(')) {
      const close = closeOf(e, 0)
      if (close < 0) return undefined
      e = (e.slice(1, close).trim().replace(/^await\s+/, '') + e.slice(close + 1)).trim()
      continue
    }
    break
  }
  // Empty every argument list and index, innermost first.
  for (let prev = ''; prev !== e;) { prev = e; e = e.replace(/\([^()]*\)/g, '()').replace(/\[[^[\]]*\]/g, '[]') }
  return /^[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\(\)|\s*\[\])*$/.test(e) ? e.replace(/\s+/g, '') : undefined
}

/** True when `chain` reads a wire value: a message property, parsed JSON, a response body or URL parameters. */
function isWireChain(chain: string, wireNames: Set<string>, localNames: Set<string>): boolean {
  const root = /^[\w$]+/.exec(chain)![0]
  const rest = chain.slice(root.length)
  if (wireNames.has(root)) return true
  if (/^JSON\.parse\(\)/.test(chain) || /\.json\(\)/.test(chain) || /(?:^|\.)searchParams(?:\.|$)/.test(chain)) return true
  if (localNames.has(root)) return false
  if (WIRE_ROOTS.has(root) && /^\??\./.test(rest)) return true
  return (root === 'event' && /^\??\.data\b/.test(rest)) || (root === 'data' && /^\??\.digest\b/.test(rest))
}

/** Local names bound to a wire chain (directly, by destructuring, or through other such names), and every other local. */
function names(masked: string): { wire: Set<string>; local: Set<string> } {
  const decls: { bound: string[]; expr: string; whole: boolean }[] = [...masked.matchAll(DECL)].map(m => ({ bound: [m[1]], expr: m[2], whole: false }))
  for (const m of masked.matchAll(DESTRUCTURE)) {
    const bound = m[1].split(',').map(p => p.split(/[:=]/).at(p.includes(':') ? 1 : 0)!.trim()).filter(n => /^[A-Za-z_$][\w$]*$/.test(n))
    decls.push({ bound, expr: m[2], whole: true })
  }
  const wire = new Set<string>()
  const local = new Set(decls.flatMap(d => d.bound))
  for (let grew = true; grew;) {
    grew = false
    for (const d of decls) {
      const chain = chainOf(d.expr)
      const fromWire = chain !== undefined && (isWireChain(chain, wire, local) || (d.whole && WIRE_SOURCES.has(chain)))
      if (!fromWire) continue
      for (const n of d.bound) if (!wire.has(n)) { wire.add(n); grew = true }
    }
  }
  return { wire, local }
}

/**
 * G-08: sign only digests you rebuilt. Flags `hashToDirectlySign:` whose value *is* a value read from a
 * message, request, body, parsed JSON or URL parameters (optionally only re-encoded by a decoder such as
 * `Utils.toArray`), directly or through a local name bound to one. A wire value passed to a builder or
 * hasher is a rebuilt digest and is not flagged. Not applicable when no source file calls `createSignature(`.
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
      const { wire, local } = names(s.masked)
      for (const m of s.masked.matchAll(HASH_KEY)) {
        const chain = chainOf(valueAt(s, m.index + m[0].length))
        if (chain === undefined || !isWireChain(chain, wire, local)) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (digest read from the wire; rebuild it yourself)`)
      }
    }
    return { findings: out.findings, applicable }
  },
}

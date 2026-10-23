import type { Rule } from './index.js'
import { closeOf, enclosingOpens, findingList, isSource, lineAt, scan, type Scan } from './util.js'

const CREATE_SIGNATURE = /\bcreateSignature\s*\(/
const HASH_KEY = /(?<![\w$])hashToDirectlySign\s*:/g
// Roots of a value that arrived over the wire, when read through a property (`msg.digest`).
const WIRE_ROOTS = new Set(['msg', 'message', 'req', 'request', 'body', 'params', 'payload'])
// Whole parameter-shaped sources a digest may be destructured from: `const { digest } = msg`.
const WIRE_SOURCES = new Set(['msg', 'message', 'req', 'request', 'payload', 'event'])
// Calls that only re-encode or hash a value: the wire chain inside them is still what gets signed (a hash
// of a sender-chosen preimage is blind signing too).
const DECODER = /^(?:Utils\s*\.\s*toArray|Buffer\s*\.\s*from|Uint8Array\s*\.\s*from|hexToBytes|toArray|(?:Hash\s*\.\s*)?(?:hash256|sha256|doubleSha256))\s*\(/
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

/** A local binding: its name, where it is declared, the block it is visible in, and whether it holds a wire value. */
interface Binding { name: string; at: number; from: number; to: number; expr: string; whole: boolean; wire: boolean }

/** The binding of `name` visible at offset `at`: the innermost enclosing block that declares it. */
function resolve(bindings: Binding[], name: string, at: number): Binding | undefined {
  let best: Binding | undefined
  for (const b of bindings) {
    if (b.name !== name || at <= b.from || at >= b.to) continue
    if (!best || b.from > best.from || (b.from === best.from && b.at < at && b.at > best.at)) best = b
  }
  return best
}

/** True when `chain`, read at offset `at`, is a wire value: a message property, parsed JSON, a response body or URL parameters. */
function isWireChain(chain: string, bindings: Binding[], at: number): boolean {
  const root = /^[\w$]+/.exec(chain)![0]
  const rest = chain.slice(root.length)
  if (/^JSON\.parse\(\)/.test(chain) || /\.json\(\)/.test(chain) || /(?:^|\.)searchParams(?:\.|$)/.test(chain)) return true
  const local = resolve(bindings, root, at)
  if (local) return local.wire
  if (WIRE_ROOTS.has(root) && /^\??\./.test(rest)) return true
  return (root === 'event' && /^\??\.data\b/.test(rest)) || (root === 'data' && /^\??\.digest\b/.test(rest))
}

/** Top-level ternary branches of an expression (the condition dropped), or the expression itself. */
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
  return ternary ? parts.slice(1) : [expr]
}

/** True when any branch of `expr`, read at offset `at`, is a wire value. */
function isWireExpr(expr: string, bindings: Binding[], at: number, whole = false): boolean {
  return branches(expr).some(b => {
    const chain = chainOf(b)
    return chain !== undefined && (isWireChain(chain, bindings, at) || (whole && WIRE_SOURCES.has(chain)))
  })
}

/** Every `const`/`let`/`var` binding, scoped to its enclosing block, with its wire flag computed to a fixed point. */
function bindingsOf(masked: string): Binding[] {
  const scope = (at: number) => {
    const open = enclosingOpens(masked, at, false).find(o => masked[o] === '{')
    if (open === undefined) return { from: -1, to: masked.length + 1 }
    const close = closeOf(masked, open)
    return { from: open, to: close < 0 ? masked.length + 1 : close }
  }
  const out: Binding[] = []
  for (const m of masked.matchAll(DECL)) out.push({ name: m[1], at: m.index, ...scope(m.index), expr: m[2], whole: false, wire: false })
  for (const m of masked.matchAll(DESTRUCTURE)) {
    const bound = m[1].split(',').map(p => p.split(/[:=]/).at(p.includes(':') ? 1 : 0)!.trim()).filter(n => /^[A-Za-z_$][\w$]*$/.test(n))
    for (const name of bound) out.push({ name, at: m.index, ...scope(m.index), expr: m[2], whole: true, wire: false })
  }
  for (let grew = true; grew;) {
    grew = false
    for (const b of out) {
      if (b.wire || !isWireExpr(b.expr, out, b.at, b.whole)) continue
      b.wire = true
      grew = true
    }
  }
  return out
}

/**
 * G-08: sign only digests you rebuilt. Flags `hashToDirectlySign:` whose value (or either branch of a ternary)
 * *is* a value read from a message, request, body, parsed JSON or URL parameters, optionally only re-encoded
 * (`Utils.toArray`) or hashed on its own (`Hash.hash256(msg.preimage)`), directly or through a local name bound
 * to one in an enclosing block. A wire value passed to a builder is a rebuilt digest and is not flagged. Not applicable when no source file calls `createSignature(`.
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
      const bindings = bindingsOf(s.masked)
      for (const m of s.masked.matchAll(HASH_KEY)) {
        if (!isWireExpr(valueAt(s, m.index + m[0].length), bindings, m.index)) continue
        const line = lineAt(s.text, m.index)
        out.add(f.rel, line, `${s.lines[line - 1].trim()} (digest read from the wire; rebuild it yourself)`)
      }
    }
    return { findings: out.findings, applicable }
  },
}

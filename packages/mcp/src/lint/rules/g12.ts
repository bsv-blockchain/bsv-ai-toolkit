import type { Rule } from './index.js'
import { enclosingOpens, findingList, inLoop, isSource, scan, withAliases, type Scan } from './util.js'

const WOC = /whatsonchain/i
const HTTP_CALL = /\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bky\s*\(/
const TX_HEX = /\/tx\/.*hex/
// A rate-limit gate, tested on code with strings blanked. Each word must start a word or a camel-case part
// and end one (`wocGate`, `gated`; not `navigate`, `scheduleRender`).
const LIMITER = /[Ll]imiter|[Tt]hrottle|(?<![A-Za-z])gate(?:d|r)?(?![a-z])|Gate(?:d|r)?(?![a-z])|(?<![A-Za-z])queue|Queue|Bottleneck|pLimit|[Rr]ateLimit|(?<![A-Za-z])schedule[dr]?(?![A-Za-z])|setTimeout/
const THUNK = /^\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\(\s*\))/
const CALLEE = /([\w$]+(?:\s*\.\s*[\w$]+)*)\s*$/
// The words of a callee that names a gate: `gated`, `wocGate`, `limit`, `queue.add`, `throttled`, `run`.
const GATE_WORD = /^(?:gate[dr]?|limit(?:er|ed)?|throttle[dr]?|queue[d]?|enqueue|schedule[dr]?|run)$/
const GATE_MODULE = /gate|limit|throttl|queue|schedul/i
const IMPORT = /\bimport\s+([^'"]*?)\s+from\s*['"]([^'"]+)['"]/g
const BLOCK_HEAD = /\b(?:if|for|while|switch|catch|with)\s*$/
const LOOP_HEAD = /\b(?:for|while)\s*(?:await\s*)?\(|\bdo\s*\{|\.(?:map|flatMap|forEach)\s*\(/

const words = (callee: string) => callee.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s._$]+/).map(w => w.toLowerCase())

/** Local names imported from a module whose path names a gate (`import { wocCall } from './woc-gate.js'`). */
function gateImports(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(IMPORT)) {
    if (!GATE_MODULE.test(m[2])) continue
    for (const n of m[1].replace(/[{}*]/g, ' ').split(',')) {
      const local = n.trim().split(/\s+as\s+/).pop()?.trim()
      if (local && local !== 'type') names.add(local)
    }
  }
  return names
}

/**
 * True when the innermost function around offset `at` is a parameterless thunk passed straight to a gate:
 * `gated(() => fetch(…))`, `limit(async () => { … fetch(…) … })`, a callee imported from a gate module.
 * A framework or utility thunk (`onMount`, `withRetry`, `setInterval`) is not a gate, and neither is a gate
 * whose thunk loops over the calls.
 */
function wrapped(s: Scan, at: number, imported: Set<string>): boolean {
  const opens = enclosingOpens(s.masked, at, false)
  for (let k = 0; k < opens.length; k++) {
    const o = opens[k]
    const before = s.masked.slice(Math.max(0, o - 60), o)
    let call = -1
    if (s.masked[o] === '(' && THUNK.test(s.masked.slice(o + 1))) call = o // expression-bodied thunk
    else if (s.masked[o] === '{') {
      if (/=>\s*$/.test(before)) {
        // block-bodied arrow: the function is the innermost; it counts only as a thunk passed to a call
        const outer = opens[k + 1]
        if (outer === undefined || s.masked[outer] !== '(' || !THUNK.test(s.masked.slice(outer + 1))) return false
        call = outer
      } else if (/\)\s*$/.test(before)) {
        // `if (…) {` is a block inside the same function; `name(…) {` is a function body of its own
        const close = o - (before.length - before.trimEnd().length) - 1
        const paren = enclosingOpens(s.masked, close, false)[0] ?? -1
        if (!BLOCK_HEAD.test(s.masked.slice(Math.max(0, paren - 12), Math.max(0, paren)))) return false
      }
      continue // a block (`else`, `try`, `do`, `if (…)`) or an object literal
    } else continue // the call's own parentheses, `(await fetch(…))`, an array
    const callee = CALLEE.exec(s.masked.slice(Math.max(0, call - 60), call))?.[1]?.replace(/\s+/g, '')
    if (!callee) return false
    const gate = words(callee).some(w => GATE_WORD.test(w)) || imported.has(callee.split('.')[0])
    return gate && !LOOP_HEAD.test(s.masked.slice(call, at))
  }
  return false
}

/**
 * G-12: Arcade first; WhatsOnChain gated. Flags a WoC `/tx/…/hex` read in browser code, and every WoC
 * call (including calls in loops) in a module with no rate-limit gate. A module with a gate token passes, and so
 * does a call whose innermost function is a thunk passed to a gate (`gated(() => fetch(…))`).
 */
export const g12: Rule = {
  id: 'G-12',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      if (!WOC.test(s.code)) continue
      const ref = withAliases(s.code, WOC)
      const gated = LIMITER.test(s.masked)
      const imported = gateImports(s.code)
      s.codeLines.forEach((t, i) => {
        if (!ref.test(t)) return
        const reasons: string[] = []
        if (f.isClient && TX_HEX.test(t)) reasons.push('WhatsOnChain tx read in browser code; ask Arcade')
        const isCall = HTTP_CALL.test(t) || (i > 0 && HTTP_CALL.test(s.codeLines[i - 1]) && /\(\s*$/.test(s.codeLines[i - 1]))
        if (isCall && !gated && !wrapped(s, s.starts[i] + t.search(ref), imported)) reasons.push(`${inLoop(s, s.starts[i] + t.search(ref)) ? 'inside a loop, ' : ''}no rate-limit gate in this module`)
        if (reasons.length) out.add(f.rel, i + 1, `${s.lines[i].trim()} (${reasons.join('; ')})`)
      })
    }
    return { findings: out.findings, applicable: true }
  },
}

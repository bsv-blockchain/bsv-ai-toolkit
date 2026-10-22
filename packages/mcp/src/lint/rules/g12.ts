import type { Rule } from './index.js'
import { enclosingOpens, findingList, inLoop, isSource, scan, withAliases, type Scan } from './util.js'

const WOC = /whatsonchain/i
const HTTP_CALL = /\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bky\s*\(/
const TX_HEX = /\/tx\/.*hex/
// A rate-limit gate, tested on code with strings blanked. `gate`/`queue` must start a word or a camel-case
// part (`wocGate`, `gated`; not `navigate`).
const LIMITER = /[Ll]imiter|[Tt]hrottle|(?<![A-Za-z])gate(?:d|r)?(?![a-z])|Gate(?:d|r)?(?![a-z])|(?<![A-Za-z])queue|Queue|Bottleneck|pLimit|[Rr]ateLimit|(?<![A-Za-z])schedule|setTimeout/
// Callees whose thunk is not a gate: loops, promise plumbing, React hooks.
const NOT_A_GATE = /^(?:fetch|map|flatMap|forEach|filter|reduce|then|catch|finally|all|allSettled|any|race|use[A-Z][\w$]*)$/
const THUNK = /^\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\(\s*\))/

/** True when offset `at` sits in a parameterless thunk passed first to a wrapper call: `gated(() => fetch(…))`. */
function wrapped(s: Scan, at: number): boolean {
  return enclosingOpens(s.masked, at, false).some(o => {
    if (s.masked[o] !== '(') return false
    const callee = /([\w$]+)\s*$/.exec(s.masked.slice(Math.max(0, o - 40), o))?.[1]
    return !!callee && !NOT_A_GATE.test(callee) && THUNK.test(s.masked.slice(o + 1))
  })
}

/**
 * G-12: Arcade first; WhatsOnChain gated. Flags a WoC `/tx/…/hex` read in browser code, and every WoC
 * call (including calls in loops) in a module with no rate-limit gate. A module with a gate token passes, and so
 * does a call wrapped in a gate: a parameterless thunk passed to an imported gate (`gated(() => fetch(…))`).
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
      s.codeLines.forEach((t, i) => {
        if (!ref.test(t)) return
        const reasons: string[] = []
        if (f.isClient && TX_HEX.test(t)) reasons.push('WhatsOnChain tx read in browser code; ask Arcade')
        const isCall = HTTP_CALL.test(t) || (i > 0 && HTTP_CALL.test(s.codeLines[i - 1]) && /\(\s*$/.test(s.codeLines[i - 1]))
        if (isCall && !gated && !wrapped(s, s.starts[i] + t.search(ref))) reasons.push(`${inLoop(s, s.starts[i] + t.search(ref)) ? 'inside a loop, ' : ''}no rate-limit gate in this module`)
        if (reasons.length) out.add(f.rel, i + 1, `${s.lines[i].trim()} (${reasons.join('; ')})`)
      })
    }
    return { findings: out.findings, applicable: true }
  },
}

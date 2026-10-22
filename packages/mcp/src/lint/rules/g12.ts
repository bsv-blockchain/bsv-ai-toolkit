import type { Rule } from './index.js'
import { findingList, inLoop, isSource, scan, withAliases } from './util.js'

const WOC = /whatsonchain/i
const HTTP_CALL = /\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bky\s*\(/
const TX_HEX = /\/tx\/.*hex/
// A rate-limit gate. `gate`/`queue` must start a word or a camel-case part (`wocGate`, not `navigate`).
const LIMITER = /[Ll]imiter|[Tt]hrottle|(?<![A-Za-z])gate(?![a-z])|Gate(?![a-z])|(?<![A-Za-z])queue|Queue|Bottleneck|p-limit|pLimit|setTimeout/

/**
 * G-12: Arcade first; WhatsOnChain gated. Flags a WoC `/tx/…/hex` read in browser code, and every WoC
 * call (including calls in loops) in a module with no rate-limit gate. A module with a gate passes.
 */
export const g12: Rule = {
  id: 'G-12',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      if (!WOC.test(s.code)) continue
      const ref = withAliases(s.code, WOC)
      const gated = LIMITER.test(s.code)
      s.codeLines.forEach((t, i) => {
        if (!ref.test(t)) return
        const reasons: string[] = []
        if (f.isClient && TX_HEX.test(t)) reasons.push('WhatsOnChain tx read in browser code; ask Arcade')
        const isCall = HTTP_CALL.test(t) || (i > 0 && HTTP_CALL.test(s.codeLines[i - 1]) && /\(\s*$/.test(s.codeLines[i - 1]))
        if (isCall && !gated) reasons.push(`${inLoop(s, s.starts[i] + t.search(ref)) ? 'inside a loop, ' : ''}no rate-limit gate in this module`)
        if (reasons.length) out.add(f.rel, i + 1, `${s.lines[i].trim()} (${reasons.join('; ')})`)
      })
    }
    return { findings: out.findings, applicable: true }
  },
}

import { extname } from 'node:path'
import type { Rule } from './index.js'
import { findingList, isDisplayChoice, isSource, matchingLines, scan } from './util.js'

// "Waiting for confirmation", "Awaiting 6 confirmations", `Waiting for ${n} block confirmations`. A count or
// block word may sit in between, but not other nouns: "waiting for wallet confirmation" is an approval prompt.
const WAIT_UI = /\b(?:wait(?:ing)?\s+for|awaiting)\s+(?:(?:a|the|one|\d+|\$\{[^}]+\}|\{[^}]+\})\s+)?(?:(?:block(?:chain)?|network|on-?chain)\s+)?confirmations?\b/i
const CONF_COUNT = /\bconfirmations\s*[<>]=?\s*\d/

/** G-14: no confirmation waits: "waiting for confirmation" in UI code, or logic keyed on a confirmation count. */
export const g14: Rule = {
  id: 'G-14',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files) {
      if (f.isClient && !f.isTest && extname(f.rel) === '.html') {
        for (const m of matchingLines(f.text, WAIT_UI)) out.add(f.rel, m.line, m.text)
      }
      if (!isSource(f)) continue
      const s = scan(f)
      s.codeLines.forEach((t, i) => {
        const count = CONF_COUNT.exec(t)
        const ui = f.isClient && WAIT_UI.test(t)
        if (ui || (count && !isDisplayChoice(t.slice(count.index + count[0].length)))) out.add(f.rel, i + 1, s.lines[i].trim())
      })
    }
    return { findings: out.findings, applicable: true }
  },
}

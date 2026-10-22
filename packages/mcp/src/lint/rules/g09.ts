import type { Rule } from './index.js'
import { findingList, isSource, lineAt, matchingCodeLines, scan } from './util.js'

const SDK_IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@bsv\/sdk['"]/g
const ARC_NAME = /(?<![\w$])ARC(?![\w$])/
// `new ARC(`, the legacy ARC API path, the ARC hosts, and WhatsOnChain's broadcast endpoint.
const LEGACY = /\bnew\s+ARC\s*\(|\/v1\/txs?\b|\barc\.taal\.com\b|\barc\.gorillapool\.io\b|\/tx\/raw\b/i

/** G-09: broadcast only through Arcade; never the SDK `ARC` class, `/v1/tx`, the ARC hosts or WoC `/tx/raw`. */
export const g09: Rule = {
  id: 'G-09',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      for (const m of s.code.matchAll(SDK_IMPORT)) {
        const arc = ARC_NAME.exec(m[1])
        if (!arc) continue
        const line = lineAt(s.text, m.index + m[0].indexOf(m[1]) + arc.index)
        out.add(f.rel, line, s.lines[line - 1].trim())
      }
      for (const m of matchingCodeLines(f, LEGACY)) out.add(f.rel, m.line, m.text)
    }
    out.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    return { findings: out.findings, applicable: true }
  },
}

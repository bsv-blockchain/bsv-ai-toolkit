import { basename } from 'node:path'
import type { Rule } from './index.js'

const TRUST_HEADING = /^ {0,3}#{1,6}\s+.*\btrust model\b/im

/** G-34: the app states its trust model, in a `TRUST.md` or a README heading naming the trust model. */
export const g34: Rule = {
  id: 'G-34',
  run({ files, meta }) {
    if (files.some(f => basename(f.rel).toLowerCase() === 'trust.md')) return { findings: [], applicable: true }
    const readmes = files.filter(f => basename(f.rel).toLowerCase() === 'readme.md')
    if (readmes.some(f => TRUST_HEADING.test(f.text))) return { findings: [], applicable: true }
    // Line 1 of the README, so `<!-- bsv-guardrail-ignore G-34 reason -->` there can suppress it; line 0 when there is none.
    const readme = readmes.find(f => f.rel.toLowerCase() === 'readme.md') ?? readmes[0]
    const snippet = 'no TRUST.md and no "Trust model" heading in a README'
    const finding = { id: meta.id, severity: meta.severity, file: readme?.rel ?? 'README.md', line: readme ? 1 : 0, snippet }
    return { findings: [finding], applicable: true }
  },
}

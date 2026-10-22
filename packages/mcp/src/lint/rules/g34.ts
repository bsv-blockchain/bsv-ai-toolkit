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
    const file = readmes.find(f => f.rel.toLowerCase() === 'readme.md')?.rel ?? readmes[0]?.rel ?? 'README.md'
    const snippet = 'no TRUST.md and no "Trust model" heading in a README'
    return { findings: [{ id: meta.id, severity: meta.severity, file, line: 0, snippet }], applicable: true }
  },
}

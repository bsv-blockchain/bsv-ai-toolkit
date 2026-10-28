import { isDeepStrictEqual } from 'node:util'
import type { Rule, RuleResult } from './index.js'
import { findManifests, lineAt, parseJson } from './util.js'

type Manifest = { metanet?: { groupPermissions?: unknown }; babbage?: { groupPermissions?: unknown } }

/** G-03 (shape A): `public/manifest.json` exists with identical `metanet` and `babbage` group permissions. */
export const g03: Rule = {
  id: 'G-03',
  run({ files, shape, meta }) {
    if (shape !== 'A' && shape !== 'A+B') return { findings: [], applicable: false }
    const finding = (file: string, line: number, snippet: string) => ({ id: meta.id, severity: meta.severity, file, line, snippet })
    const manifests = findManifests(files)
    if (!manifests.length) return { findings: [finding('public/manifest.json', 0, 'public/manifest.json not found')], applicable: true }

    const findings: RuleResult['findings'] = []
    for (const f of manifests) {
      const json = parseJson(f.text) as Manifest | undefined
      if (!json || typeof json !== 'object') {
        findings.push(finding(f.rel, 1, 'manifest.json is not valid JSON'))
        continue
      }
      const metanet = json.metanet?.groupPermissions
      const babbage = json.babbage?.groupPermissions
      const at = (key: string) => {
        const i = f.text.search(new RegExp(`"${key}"\\s*:`))
        return i < 0 ? 1 : lineAt(f.text, i)
      }
      if (metanet === undefined) findings.push(finding(f.rel, at('metanet'), 'metanet.groupPermissions is missing'))
      else if (babbage === undefined) findings.push(finding(f.rel, at('babbage'), 'babbage.groupPermissions is missing'))
      else if (!isDeepStrictEqual(metanet, babbage)) {
        findings.push(finding(f.rel, at('babbage'), 'babbage.groupPermissions differs from metanet.groupPermissions'))
      }
    }
    return { findings, applicable: true }
  },
}

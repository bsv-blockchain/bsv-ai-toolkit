import { basename, dirname } from 'node:path'
import type { ProjectFile } from '../walk.js'
import type { Rule } from './index.js'
import { dependencies, findingList, isSource, jsonKeyLine, lineAt, matchingCodeLines, parseJson, scan } from './util.js'

const RUNAR = /^runar-[\w-]+$/
// An npm range that can only resolve to 0.4.x (npm has no newer Rúnar release).
const NPM_04 = /^\s*(?:[\^~=v]|>=?)?\s*0\.4(?:\.(?:\d+|x|\*)|$)/
// pnpm-lock.yaml: `runar-sdk@0.4.6:` (v9) or `/runar-sdk/0.4.6:` (v6–v8). `@file:` entries are vendored.
const PNPM_LOCK = /(?:^|[\s'"/])(runar-[\w-]+)[@/](0\.4\.\d+)(?![\w.-])/
const RUNAR_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]runar-sdk(?:\/[^'"]*)?['"]/
const VITE_CONFIG = /^vite\.config\.[cm]?[jt]s$/
// A `node:url` alias (object or `find:` form), or a node-polyfills plugin that aliases it.
const NODE_URL_ALIAS = /['"]node:url['"]\s*:|\bfind\s*:\s*['"]node:url['"]|\bfind\s*:\s*\/[^\n]*node:|\bnodePolyfills\s*\(/

/** Names whose override (pnpm.overrides, overrides, resolutions) points away from npm. */
function vendored(pkg: Record<string, unknown>): Set<string> {
  const maps = [(pkg.pnpm as Record<string, unknown> | undefined)?.overrides, pkg.overrides, pkg.resolutions]
  const out = new Set<string>()
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue
    for (const [key, v] of Object.entries(map)) {
      const name = key.split('/').pop()!.replace(/(.)@.*$/, '$1')
      if (typeof v === 'string' && !NPM_04.test(v)) out.add(name)
    }
  }
  return out
}

/** The vite config whose folder holds `file` most closely, if any. */
function viteConfigFor(file: ProjectFile, configs: ProjectFile[]): ProjectFile | undefined {
  const holds = (c: ProjectFile) => { const d = dirname(c.rel); return d === '.' || file.rel.startsWith(`${d}/`) }
  return configs.filter(holds).sort((a, b) => b.rel.length - a.rel.length)[0]
}

/**
 * G-25: Rúnar from upstream. Flags a `package.json` or lockfile pin of `runar-*` at 0.4.x from npm, and
 * `runar-sdk` imported in browser code of a Vite project whose `vite.config.*` has no `node:url` alias.
 */
export const g25: Rule = {
  id: 'G-25',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files) {
      const name = basename(f.rel)
      if (name === 'package.json') {
        const pkg = parseJson(f.text)
        if (!pkg || typeof pkg !== 'object') continue
        const skip = vendored(pkg as Record<string, unknown>)
        for (const [dep, spec] of Object.entries(dependencies(pkg))) {
          if (!RUNAR.test(dep) || skip.has(dep) || !NPM_04.test(spec)) continue
          const line = jsonKeyLine(f.text, dep, spec)
          out.add(f.rel, line, `${f.text.split(/\r?\n/)[line - 1].trim()} (npm runar-* 0.4.x is stale and unsafe)`)
        }
      } else if (name === 'pnpm-lock.yaml') {
        const seen = new Set<string>()
        f.text.split(/\r?\n/).forEach((t, i) => {
          const m = PNPM_LOCK.exec(t)
          if (!m || seen.has(`${m[1]}@${m[2]}`)) return
          seen.add(`${m[1]}@${m[2]}`)
          out.add(f.rel, i + 1, `${t.trim()} (npm runar-* 0.4.x is stale and unsafe)`)
        })
      } else if (name === 'package-lock.json') {
        const lock = parseJson(f.text) as { packages?: Record<string, { version?: string; resolved?: string }> } | undefined
        const seen = new Set<string>()
        for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
          const dep = key.split('node_modules/').pop()!
          const fromNpm = !entry.resolved || /registry\.npmjs\.org/.test(entry.resolved)
          if (!RUNAR.test(dep) || !/^0\.4\./.test(entry.version ?? '') || !fromNpm || seen.has(`${dep}@${entry.version}`)) continue
          seen.add(`${dep}@${entry.version}`)
          const line = lineAt(f.text, Math.max(0, f.text.indexOf(`"${key}"`)))
          out.add(f.rel, line, `${key} ${entry.version} (npm runar-* 0.4.x is stale and unsafe)`)
        }
      }
    }

    const configs = files.filter(f => VITE_CONFIG.test(basename(f.rel)))
    for (const f of files.filter(f => f.isClient && isSource(f) && !configs.includes(f))) {
      const config = viteConfigFor(f, configs)
      if (!config || NODE_URL_ALIAS.test(scan(config).code)) continue
      for (const m of matchingCodeLines(f, RUNAR_IMPORT)) out.add(f.rel, m.line, `${m.text} (${config.rel} has no node:url alias)`)
    }
    return { findings: out.findings, applicable: true }
  },
}

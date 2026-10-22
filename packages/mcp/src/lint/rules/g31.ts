import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Rule } from './index.js'
import { dependencies, findingList, jsonKeyLine, parseJson } from './util.js'

type Pins = Record<string, { pinned: string; verified: string }>

const VERSION = /^\s*(\^|~|>=?|=|v)?\s*(\d+)(?:\.(\d+))?/

function loadPins(contentDir: string): Pins {
  const json = JSON.parse(readFileSync(join(contentDir, 'versions.json'), 'utf8')) as { packages?: Pins }
  return json.packages ?? {}
}

/** True when `spec` cannot reach `pinned` because its major.minor is lower (a `^` or `>=` range that admits it passes). */
export function behindPin(spec: string, pinned: string): boolean {
  const m = VERSION.exec(spec)
  const pin = VERSION.exec(pinned)
  if (!m || !pin) return false // workspace:, file:, git, latest, *
  const [op, major, minor] = [m[1], Number(m[2]), m[3] === undefined ? undefined : Number(m[3])]
  const [pinMajor, pinMinor] = [Number(pin[2]), Number(pin[3] ?? 0)]
  if (op?.startsWith('>')) return false
  if (op === '^' && major > 0 && major === pinMajor) return false
  return major < pinMajor || (major === pinMajor && minor !== undefined && minor < pinMinor)
}

/** G-31: a `package.json` dependency the kit pins (`versions.json#packages`) whose major.minor is behind the pin. */
export const g31: Rule = {
  id: 'G-31',
  run({ files, meta, contentDir }) {
    const out = findingList(meta)
    const pins = loadPins(contentDir)
    for (const f of files.filter(f => basename(f.rel) === 'package.json')) {
      for (const [name, spec] of Object.entries(dependencies(parseJson(f.text)))) {
        const pin = pins[name]
        if (!pin || !behindPin(spec, pin.pinned)) continue
        const line = jsonKeyLine(f.text, name, spec)
        out.add(f.rel, line, `${f.text.split(/\r?\n/)[line - 1].trim()} (kit pins ${pin.pinned}, verified ${pin.verified})`)
      }
    }
    return { findings: out.findings, applicable: true }
  },
}

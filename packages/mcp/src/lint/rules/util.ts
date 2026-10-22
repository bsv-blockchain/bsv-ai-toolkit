import { extname } from 'node:path'
import type { ProjectFile } from '../walk.js'

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/** Non-test source code (not JSON, Markdown, YAML or env files). */
export function isSource(file: ProjectFile): boolean {
  return CODE_EXTS.has(extname(file.rel)) && !file.isTest
}

/** 1-based line number of the character at `index` in `text`. */
export function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Every line of `text` (LF or CRLF) matching `re`, with its 1-based line number and trimmed text. */
export function matchingLines(text: string, re: RegExp): { line: number; text: string }[] {
  return text.split(/\r?\n/).flatMap((t, i) => (re.test(t) ? [{ line: i + 1, text: t.trim() }] : []))
}

/** `public/manifest.json` at the project root, or under a sub-app (e.g. `web/public/manifest.json`). */
export function findManifests(files: ProjectFile[]): ProjectFile[] {
  return files.filter(f => f.rel === 'public/manifest.json' || f.rel.endsWith('/public/manifest.json'))
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

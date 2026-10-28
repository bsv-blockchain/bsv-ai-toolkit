import { extname } from 'node:path'
import type { Finding, Severity } from '../../types.js'
import type { ProjectFile } from '../walk.js'

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/** Non-test source code (not JSON, Markdown, YAML or env files). */
export function isSource(file: ProjectFile): boolean {
  return CODE_EXTS.has(extname(file.rel)) && !file.isTest
}

/** Findings for one rule, at most one per file and line. */
export function findingList(meta: { id: string; severity: Severity }) {
  const findings: Omit<Finding, 'ref' | 'fix'>[] = []
  const seen = new Set<string>()
  return {
    findings,
    add(file: string, line: number, snippet: string) {
      const key = `${file}:${line}`
      if (seen.has(key)) return
      seen.add(key)
      findings.push({ id: meta.id, severity: meta.severity, file, line, snippet })
    },
  }
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

/**
 * A source file split into views that keep every character's offset:
 * `code` has comments blanked (strings kept, so URLs still match); `masked` also blanks the contents
 * of strings, templates and regex literals (delimiters and `${…}` code kept), for bracket matching.
 */
export interface Scan {
  text: string
  code: string
  masked: string
  /** Offset of the first character of each line. */
  starts: number[]
  /** Comment-free text of each line (CR dropped). */
  codeLines: string[]
  /** Original text of each line (CR dropped). */
  lines: string[]
}

const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^'])
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|instanceof|new|delete|throw)$/

function tokenize(text: string): { code: string; masked: string } {
  // UTF-16 units (not code points), so offsets match `text`.
  const codeU = text.split('')
  const maskedU = text.split('')
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' '
  }
  const n = text.length
  const templateDepth: number[] = [] // open braces inside each `${`
  let inTemplate = false
  let prev = '' // last significant character in code
  let i = 0
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (inTemplate) {
      if (c === '\\') { blank(maskedU, i, i + 2); i += 2; continue }
      if (c === '`') { inTemplate = false; prev = '`'; i++; continue }
      if (c === '$' && d === '{') { templateDepth.push(0); inTemplate = false; prev = '{'; i += 2; continue }
      blank(maskedU, i, i + 1); i++; continue
    }
    if (c === '/' && d === '/') {
      const newline = text.indexOf('\n', i)
      const end = newline < 0 ? n : newline
      blank(codeU, i, end); blank(maskedU, i, end); i = end; continue
    }
    if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      blank(codeU, i, end); blank(maskedU, i, end); i = end; continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      blank(maskedU, i + 1, Math.min(j, n))
      i = j < n && text[j] === c ? j + 1 : j
      prev = c
      continue
    }
    if (c === '`') { inTemplate = true; i++; continue }
    if (c === '/' && (prev === '' || REGEX_AFTER.has(prev) || REGEX_AFTER_WORD.test(text.slice(Math.max(0, i - 12), i).trimEnd()))) {
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++
        else if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        j++
      }
      if (j < n && text[j] === '/') {
        blank(maskedU, i + 1, j)
        i = j + 1
        prev = '/'
        continue
      }
    }
    if (templateDepth.length) {
      const top = templateDepth.length - 1
      if (c === '{') templateDepth[top]++
      else if (c === '}') {
        if (templateDepth[top] === 0) { templateDepth.pop(); inTemplate = true; i++; continue }
        templateDepth[top]--
      }
    }
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? 'w' : c
    i++
  }
  return { code: codeU.join(''), masked: maskedU.join('') }
}

const scans = new WeakMap<ProjectFile, Scan>()

/** Scans `file` once (cached per file object). */
export function scan(file: ProjectFile): Scan {
  let s = scans.get(file)
  if (!s) {
    const { code, masked } = tokenize(file.text)
    const starts = [0]
    for (let i = 0; i < file.text.length; i++) if (file.text.charCodeAt(i) === 10) starts.push(i + 1)
    s = { text: file.text, code, masked, starts, codeLines: code.split(/\r?\n/), lines: file.text.split(/\r?\n/) }
    scans.set(file, s)
  }
  return s
}

/** Like `matchingLines`, but `re` is tested on comment-free code; the snippet is the original line. */
export function matchingCodeLines(file: ProjectFile, re: RegExp): { line: number; text: string }[] {
  const s = scan(file)
  return s.codeLines.flatMap((t, i) => (re.test(t) ? [{ line: i + 1, text: s.lines[i].trim() }] : []))
}

const OPENERS = new Set(['(', '[', '{'])
const CLOSERS = new Set([')', ']', '}'])

/** Index of the bracket that closes the one at `open` in `masked`, or -1. */
export function closeOf(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (OPENERS.has(masked[i])) depth++
    else if (CLOSERS.has(masked[i]) && --depth === 0) return i
  }
  return -1
}

const LOOP = /\b(?:for|while)\s*(?:await\s*)?\(|\bdo\s*\{|\.(?:map|flatMap|forEach)\s*\(|\bPromise\.(?:all|allSettled|any|race)\s*\(/g

/**
 * True when offset `index` lies inside the body of a `for`/`while`/`do` loop, or inside the
 * arguments of `.map(`, `.flatMap(`, `.forEach(` or `Promise.all(` (and its siblings).
 */
export function inLoop(s: Scan, index: number): boolean {
  for (const m of s.masked.matchAll(LOOP)) {
    if (m.index >= index) break
    const open = m.index + m[0].length - 1
    const close = closeOf(s.masked, open)
    if (close < 0) continue
    let from = open
    let to = close
    if (/^(?:for|while)/.test(m[0])) {
      // the header is not the body: skip to the statement after `)`
      let k = close + 1
      while (k < s.masked.length && /\s/.test(s.masked[k])) k++
      if (s.masked[k] === '{') { from = k; to = closeOf(s.masked, k) }
      else {
        from = close
        const stop = s.masked.slice(k).search(/[;\n]/)
        to = stop < 0 ? s.masked.length : k + stop
      }
    }
    if (from < index && index < to) return true
  }
  return false
}

/** Comment-free text between the bracket at `open` and its match, cut after `maxLines` lines. */
export function bracketText(s: Scan, open: number, maxLines: number): { code: string; masked: string; end: number } {
  const close = closeOf(s.masked, open)
  const line = lineAt(s.text, open)
  const limit = s.starts[line - 1 + maxLines] ?? s.text.length
  const end = close < 0 || close > limit ? limit : close
  return { code: s.code.slice(open + 1, end), masked: s.masked.slice(open + 1, end), end }
}

const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)\s*([^\n;]*)/g
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A regex matching `re` or any local name bound (directly or through other such names) to an
 * expression matching `re`, e.g. `const base = 'https://api.whatsonchain.com'` makes `base` match.
 */
export function withAliases(code: string, re: RegExp): RegExp {
  const names: string[] = []
  // A value read from the service (`const res = await fetch(woc…)`) is a response, not an address.
  const decls = [...code.matchAll(DECL)].map(m => ({ name: m[1], expr: m[2] })).filter(d => !/\bawait\b|\bfetch\s*\(|\baxios\b/.test(d.expr))
  const refers = (expr: string) => re.test(expr) || names.some(n => new RegExp(`(?<![\\w$])${escapeRe(n)}(?![\\w$])`).test(expr))
  for (let grew = true; grew;) {
    grew = false
    for (const d of decls) if (!names.includes(d.name) && refers(d.expr)) { names.push(d.name); grew = true }
  }
  if (!names.length) return re
  const flags = re.flags.replace('g', '')
  return new RegExp(`${re.source}|(?<![\\w$])(?:${names.map(escapeRe).join('|')})(?![\\w$])`, flags)
}

/**
 * True when the expression after a comparison (`rest`, the line text after it) only picks a label:
 * a ternary yielding a string or JSX (`=== 'MINED' ? 'In a block' : …`) or a JSX `&&` element.
 */
export function isDisplayChoice(rest: string): boolean {
  return /^[^?;]*\?(?![.?])\s*['"`<(]/.test(rest) || /^[^;]*?&&\s*\(?\s*</.test(rest)
}

/** True when a branch body only returns or assigns a string literal (a label, not an action). */
export function isLiteralBody(body: string): boolean {
  return /^\s*\{?\s*(?:return\s+|[\w$.[\]'"]+\s*=\s*)?(['"`])[^'"`]*\1\s*;?\s*(?:break\s*;?)?\s*\}?\s*$/.test(body)
}

/** `package.json` dependency maps, merged (later sections win). */
export function dependencies(pkg: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!pkg || typeof pkg !== 'object') return out
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = (pkg as Record<string, unknown>)[key]
    if (deps && typeof deps === 'object') {
      for (const [name, v] of Object.entries(deps)) if (typeof v === 'string') out[name] = v
    }
  }
  return out
}

/** 1-based line of `"name": "spec"` in a JSON text (the first `"name"` key when the pair is not on one line). */
export function jsonKeyLine(text: string, name: string, spec?: string): number {
  const key = `"${escapeRe(name)}"\\s*:`
  const pair = spec === undefined ? -1 : text.search(new RegExp(`${key}\\s*"${escapeRe(spec)}"`))
  const at = pair >= 0 ? pair : text.search(new RegExp(key))
  return at < 0 ? 1 : lineAt(text, at)
}

/**
 * Offsets of the unmatched brackets around `index` in `masked`, innermost first. With `stopAtBrace`, the
 * walk ends at the first enclosing `{` (a block or object), which is not included.
 */
export function enclosingOpens(masked: string, index: number, stopAtBrace: boolean): number[] {
  const out: number[] = []
  let depth = 0
  for (let i = index - 1; i >= 0; i--) {
    const c = masked[i]
    if (CLOSERS.has(c)) depth++
    else if (OPENERS.has(c)) {
      if (depth > 0) { depth--; continue }
      if (c === '{' && stopAtBrace) break
      out.push(i)
    }
  }
  return out
}

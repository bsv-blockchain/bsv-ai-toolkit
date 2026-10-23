import type { Rule } from './index.js'
import { closeOf, enclosingOpens, findingList, isDisplayChoice, isLiteralBody, isSource, lineAt, scan, withAliases, type Scan } from './util.js'

const MINED = /['"`]MINED['"`]/
const SEEN = /SEEN_ON_NETWORK|SEEN_MULTIPLE_NODES/
const CMP = String.raw`(?:[!=]==?|(?<!=)[<>]=?)`
const MINED_CMP = new RegExp(String.raw`${CMP}\s*['"\`]MINED['"\`]|['"\`]MINED['"\`]\s*${CMP}`)
const CONF_CMP = new RegExp(String.raw`\.confirmations\b\s*${CMP}|${CMP}\s*[\w$.]*\.confirmations\b`)
const BRANCH_BEFORE = /\b(?:if|while)\s*$/
const JOINED_AFTER = /(?:\|\||&&|\?\?)\s*$/
const JOINED_BEFORE = /^\s*(?:\|\||&&|\?\?)/
const CASE_MINED = /\bcase\s+['"`]MINED['"`]\s*:/
// One whitespace char after `case`, so a label splits only one way (no backtracking blow-up).
const CASE_ONLY = /^\s*(?:case\s[^:]*:\s*)+$/
// POST /tx (or /txs): the path ends the string. `/tx/…` is a status read.
const TX_POST_PATH = /\/txs?['"`]/
const POST = /method\s*:\s*['"`]POST['"`]/i
const TX_READ = /\/tx\/(?!raw\b)/
const WOC = /whatsonchain|\bwoc/i

/** The next non-blank comment-free line after `i` (0-based), or ''. */
function nextCodeLine(s: Scan, i: number, skip: RegExp = /^\s*$/): string {
  for (let k = i + 1; k < s.codeLines.length; k++) if (!skip.test(s.codeLines[k]) && s.codeLines[k].trim()) return s.codeLines[k]
  return ''
}

/** True when the `if`/`while` whose condition opens at `open` only returns or assigns a label. */
function labelOnlyBranch(s: Scan, open: number): boolean {
  const close = closeOf(s.masked, open)
  if (close < 0) return false
  const i = lineAt(s.text, close) - 1
  const lineEnd = s.starts[i + 1] ?? s.text.length
  let body = s.code.slice(close + 1, Math.max(close + 1, lineEnd)).replace(/\r?\n$/, '')
  if (close + 1 >= lineEnd || /^\s*\{?\s*$/.test(body)) body = nextCodeLine(s, i)
  return isLiteralBody(body)
}

/**
 * The whole condition around offset `at` on line `i`: the enclosing `if`/`while` header, else the outermost
 * enclosing parentheses, else the lines joined to line `i` by a trailing or leading `||`, `&&` or `??`.
 */
function conditionText(s: Scan, at: number, i: number, cond: number | undefined): string {
  const parens = enclosingOpens(s.masked, at, true).filter(o => s.masked[o] === '(')
  const open = cond ?? parens[parens.length - 1]
  if (open !== undefined) {
    const close = closeOf(s.masked, open)
    return s.code.slice(open, close < 0 ? undefined : close + 1)
  }
  let a = i
  let b = i
  while (a > 0 && (JOINED_AFTER.test(s.codeLines[a - 1]) || JOINED_BEFORE.test(s.codeLines[a]))) a--
  while (b < s.codeLines.length - 1 && (JOINED_AFTER.test(s.codeLines[b]) || JOINED_BEFORE.test(s.codeLines[b + 1]))) b++
  return s.codeLines.slice(a, b + 1).join('\n')
}

/** True when the `case 'MINED':` on line `i` shares its body with a SEEN case, or its body is only a label. */
function harmlessCase(s: Scan, i: number): boolean {
  const labels = [s.codeLines[i]]
  for (let k = i - 1; k >= 0 && CASE_ONLY.test(s.codeLines[k]); k--) labels.push(s.codeLines[k])
  let k = i + 1
  const rest = s.codeLines[i].slice(s.codeLines[i].search(CASE_MINED)).replace(/^[^:]*:/, '')
  labels.push(rest)
  if (CASE_ONLY.test(rest) || !rest.trim()) {
    for (; k < s.codeLines.length && (CASE_ONLY.test(s.codeLines[k]) || !s.codeLines[k].trim()); k++) labels.push(s.codeLines[k])
  }
  if (labels.some(l => SEEN.test(l))) return true
  const body = rest.trim() && !CASE_ONLY.test(rest) ? rest.replace(/^(?:\s*case\s[^:]*:)+/, '') : s.codeLines[k] ?? ''
  return isLiteralBody(body)
}

/**
 * True when line `i` (0-based) gates on MINED or a confirmation count: a comparison, or a MINED literal in
 * an `if`/`while` condition. Labels pass, and so does a condition (even one split over lines) that also
 * accepts SEEN_ON_NETWORK.
 */
function gatesOnBlock(s: Scan, i: number): boolean {
  const t = s.codeLines[i]
  if (CASE_MINED.test(t)) return !SEEN.test(t) && !harmlessCase(s, i)
  const cmp = MINED_CMP.exec(t) ?? CONF_CMP.exec(t)
  const hit = cmp ?? MINED.exec(t)
  if (!hit) return false
  const at = s.starts[i] + hit.index
  const cond = enclosingOpens(s.masked, at, true).find(o => s.masked[o] === '(' && BRANCH_BEFORE.test(s.masked.slice(Math.max(0, o - 12), o)))
  if (!cmp && cond === undefined) return false
  if (SEEN.test(conditionText(s, at, i, cond))) return false
  if (cmp && isDisplayChoice(t.slice(cmp.index + cmp[0].length))) return false
  return !(cond !== undefined && labelOnlyBranch(s, cond))
}

/**
 * G-10: money is final at SEEN_ON_NETWORK, never MINED. Flags a branch or comparison on `'MINED'` or
 * `.confirmations` (labels, type unions and conditions that also accept SEEN_ON_NETWORK pass), and a module
 * that POSTs to Arcade's `/tx` with no `GET /tx/{txid}` read.
 */
export const g10: Rule = {
  id: 'G-10',
  run({ files, meta }) {
    const out = findingList(meta)
    for (const f of files.filter(isSource)) {
      const s = scan(f)
      s.codeLines.forEach((_, i) => { if (gatesOnBlock(s, i)) out.add(f.rel, i + 1, s.lines[i].trim()) })

      const reads = s.codeLines.some(t => TX_READ.test(t) && !WOC.test(t))
      if (reads) continue
      // Only a POST to Arcade: a POST to the app's own relay (`/api/tx`) is not a broadcast.
      const arcade = withAliases(s.code, /arcade/i)
      s.codeLines.forEach((t, i) => {
        if (!TX_POST_PATH.test(t) || !arcade.test(t)) return
        const window = s.codeLines.slice(Math.max(0, i - 3), i + 6).join('\n')
        if (POST.test(window)) out.add(f.rel, i + 1, `${s.lines[i].trim()} (no GET /tx/{txid} read in this module)`)
      })
    }
    return { findings: out.findings, applicable: true }
  },
}

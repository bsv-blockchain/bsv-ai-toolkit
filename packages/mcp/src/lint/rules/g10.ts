import type { Rule } from './index.js'
import { closeOf, findingList, isDisplayChoice, isLiteralBody, isSource, scan, type Scan } from './util.js'

const MINED = /['"`]MINED['"`]/
const SEEN = /SEEN_ON_NETWORK|SEEN_MULTIPLE_NODES/
const CMP = String.raw`(?:[!=]==?|(?<!=)[<>]=?)`
const MINED_CMP = new RegExp(String.raw`${CMP}\s*['"\`]MINED['"\`]|['"\`]MINED['"\`]\s*${CMP}`)
const CONF_CMP = new RegExp(String.raw`\.confirmations\b\s*${CMP}|${CMP}\s*[\w$.]*\.confirmations\b`)
const BRANCH = /^\s*(?:\}\s*)?(?:else\s+)?(?:if|while)\s*\(/
const CASE_MINED = /\bcase\s+['"`]MINED['"`]\s*:/
const CASE_ONLY = /^\s*(?:case\s+[^:]+:\s*)+$/
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

/** True when the `if`/`while` on line `i` (0-based) only returns or assigns a label. */
function labelOnlyBranch(s: Scan, i: number): boolean {
  const open = s.starts[i] + s.codeLines[i].search(/\(/)
  const close = closeOf(s.masked, open)
  if (close < 0) return false
  const lineEnd = s.starts[i + 1] ?? s.text.length
  let body = s.code.slice(close + 1, Math.max(close + 1, lineEnd)).replace(/\r?\n$/, '')
  if (close + 1 >= lineEnd || /^\s*\{?\s*$/.test(body)) body = nextCodeLine(s, i)
  return isLiteralBody(body)
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
  const body = rest.trim() && !CASE_ONLY.test(rest) ? rest.replace(/^(?:\s*case\s+[^:]+:)+/, '') : s.codeLines[k] ?? ''
  return isLiteralBody(body)
}

/** True when line `i` (0-based) gates on MINED or a confirmation count (not a label, not alongside SEEN). */
function gatesOnBlock(s: Scan, i: number): boolean {
  const t = s.codeLines[i]
  if (MINED.test(t)) {
    if (SEEN.test(t)) return false
    if (CASE_MINED.test(t)) return !harmlessCase(s, i)
  }
  const cmp = MINED_CMP.exec(t) ?? CONF_CMP.exec(t)
  const branch = BRANCH.test(t) && (MINED.test(t) || CONF_CMP.test(t))
  if (!cmp && !branch) return false
  if (cmp && isDisplayChoice(t.slice(cmp.index + cmp[0].length))) return false
  return !(BRANCH.test(t) && labelOnlyBranch(s, i))
}

/**
 * G-10: money is final at SEEN_ON_NETWORK, never MINED. Flags a branch or comparison on `'MINED'` or
 * `.confirmations` (labels, type unions and lists that also accept SEEN_ON_NETWORK pass), and a module
 * that POSTs to `/tx` with no `GET /tx/{txid}` read.
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
      s.codeLines.forEach((t, i) => {
        if (!TX_POST_PATH.test(t)) return
        const window = s.codeLines.slice(Math.max(0, i - 3), i + 6).join('\n')
        if (POST.test(window)) out.add(f.rel, i + 1, `${s.lines[i].trim()} (no GET /tx/{txid} read in this module)`)
      })
    }
    return { findings: out.findings, applicable: true }
  },
}

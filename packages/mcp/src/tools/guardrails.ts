import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../config.js'
import { runGuardrails } from '../lint/engine.js'
import type { GuardrailReport } from '../types.js'
import { CONTENT_DIR } from '../content.js'
import { errorResult, textResult, type ToolResult } from './result.js'

export interface CheckInput {
  path: string
  shape?: 'A' | 'B' | 'auto'
  include?: string[]
  exclude?: string[]
}

const MAX_SKIP_NOTES = 20

/** Runs every guardrail over the project at `input.path`. Read-only: it never writes to the project. */
export async function checkGuardrails(
  input: CheckInput,
  contentDir = CONTENT_DIR,
): Promise<{ report: GuardrailReport; summary: string }> {
  // A relative path would resolve against the server's cwd (often / or $HOME), not the user's project.
  if (!isAbsolute(input.path)) throw new Error(`path must be absolute: ${input.path}`)
  const root = resolve(input.path) // normalise . and .. segments
  const st = await stat(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Error(`path not found: ${root}`)
    throw e
  })
  if (!st.isDirectory()) throw new Error(`path is not a directory: ${root}`)

  const skipped: string[] = []
  const report = await runGuardrails(root, {
    shape: input.shape,
    include: input.include,
    exclude: input.exclude,
    contentDir,
    onSkip: (rel, reason) => skipped.push(`${rel} (${reason})`),
  })
  return { report, summary: summarize(report, input.shape, skipped) }
}

function summarize(report: GuardrailReport, shape: CheckInput['shape'], skipped: string[]): string {
  const errors = report.findings.filter(f => f.severity === 'error').length
  const warnings = report.findings.length - errors
  const lines = [`check_guardrails: ${errors} errors, ${warnings} warnings, shape ${report.shapeDetected}`]
  if ((shape === 'A' || shape === 'B') && shape !== report.shapeDetected) lines.push(`checked as shape ${shape}`)
  for (const f of report.findings) {
    const where = f.file === '' ? '' : ` ${f.file}:${f.line}`
    const snippet = f.snippet === '' ? '' : `  ${f.snippet}`
    lines.push(`${f.severity} ${f.id}${where}${snippet}`, `  fix: ${f.fix} (${f.ref})`)
  }
  const list = (label: string, ids: string[]) => { if (ids.length) lines.push(`${label}: ${ids.join(', ')}`) }
  list('passed', report.passed)
  list('not applicable', report.notApplicable)
  list('manual checklist', report.manualChecklist)
  for (const s of skipped.slice(0, MAX_SKIP_NOTES)) lines.push(`note: skipped ${s}`)
  if (skipped.length > MAX_SKIP_NOTES) lines.push(`note: skipped ${skipped.length - MAX_SKIP_NOTES} more unreadable files or directories`)
  return lines.join('\n')
}

export function registerGuardrailTools(server: McpServer, _cfg: Config): void {
  server.registerTool(
    'check_guardrails',
    {
      description:
        'Statically check a BSV project against the guardrails (bsv://guardrails). Read-only: never edits files. ' +
        'Returns findings with fixes, plus the passed, not-applicable and manual-checklist guardrail ids. ' +
        'Suppress a finding with `// bsv-guardrail-ignore G-xx reason` on the line or the line above.',
      inputSchema: {
        path: z.string().describe('Absolute path of the project root to check'),
        shape: z.enum(['A', 'B', 'auto']).default('auto').describe('Custody shape; auto detects it from the code'),
        include: z.array(z.string()).optional().describe('Glob patterns to check, relative to path (default: all text files)'),
        exclude: z.array(z.string()).optional().describe('Glob patterns to skip, relative to path'),
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const { report, summary } = await checkGuardrails(input)
        return textResult(summary, report)
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}

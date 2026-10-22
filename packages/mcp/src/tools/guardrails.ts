import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../config.js'
import { runGuardrails } from '../lint/engine.js'
import type { GuardrailReport } from '../types.js'

export interface CheckInput {
  path: string
  shape?: 'A' | 'B' | 'auto'
  include?: string[]
  exclude?: string[]
}

// Two levels up from src/tools or build/tools is the package root.
const CONTENT_DIR = fileURLToPath(new URL('../../content', import.meta.url))
const MAX_SKIP_NOTES = 20

/** Runs every guardrail over the project at `input.path`. Read-only: it never writes to the project. */
export async function checkGuardrails(
  input: CheckInput,
  contentDir = CONTENT_DIR,
): Promise<{ report: GuardrailReport; summary: string }> {
  const root = resolve(input.path)
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
  if (skipped.length > MAX_SKIP_NOTES) lines.push(`note: skipped ${skipped.length - MAX_SKIP_NOTES} more unreadable files`)
  return lines.join('\n')
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

export function registerGuardrailTools(server: McpServer, _cfg: Config): void {
  server.registerTool(
    'check_guardrails',
    {
      description:
        'Statically check a BSV project against the guardrails (bsv://guardrails). Read-only: never edits files. ' +
        'Returns findings with fixes, plus the passed, not-applicable and manual-checklist guardrail ids. ' +
        'Suppress a finding with `// bsv-guardrail-ignore G-xx reason` on the line or the line above.',
      inputSchema: {
        path: z.string().describe('Project root to check (absolute, or relative to the server working directory)'),
        shape: z.enum(['A', 'B', 'auto']).default('auto').describe('Custody shape; auto detects it from the code'),
        include: z.array(z.string()).optional().describe('Glob patterns to check, relative to path (default: all text files)'),
        exclude: z.array(z.string()).optional().describe('Glob patterns to skip, relative to path'),
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const { report, summary } = await checkGuardrails(input)
        return { content: [{ type: 'text', text: summary }], structuredContent: report as unknown as Record<string, unknown> }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }
      }
    },
  )
}

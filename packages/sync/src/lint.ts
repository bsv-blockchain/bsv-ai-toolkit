import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import type { ZodType } from 'zod'
import { BrcCategoriesFile, DocsIndexFile, GuardrailSchema, VerifiedDate, VersionsFile } from './schema.js'

const MARKDOWN_WITH_FRONTMATTER = ['facts/*.md', 'custody-shapes.md', 'threat-model.md', 'simple/*.md']
const GUARDRAIL_IDS = Array.from({ length: 34 }, (_, i) => 'G-' + String(i + 1).padStart(2, '0'))

export async function lintContent(contentDir: string): Promise<{ errors: string[] }> {
  const errors: string[] = []
  await lintFrontmatter(contentDir, errors)
  await lintGuardrails(contentDir, errors)
  await lintDataFile(contentDir, 'versions.json', VersionsFile, errors)
  await lintDataFile(contentDir, 'docs-index.yaml', DocsIndexFile, errors)
  await lintDataFile(contentDir, 'brc-categories.json', BrcCategoriesFile, errors)
  return { errors }
}

function frontmatter(text: string): unknown {
  const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  return match ? parseYaml(match[1]) : undefined
}

async function lintFrontmatter(dir: string, errors: string[]): Promise<void> {
  const files = (await fg(MARKDOWN_WITH_FRONTMATTER, { cwd: dir })).sort()
  for (const file of files) {
    let fm: unknown
    try {
      fm = frontmatter(await readFile(join(dir, file), 'utf8'))
    } catch (e) {
      errors.push(`${file}: frontmatter is not valid YAML (${(e as Error).message})`)
      continue
    }
    if (fm === undefined || fm === null || typeof fm !== 'object') {
      errors.push(`${file}: missing frontmatter (needs verified and title)`)
      continue
    }
    const { verified, title } = fm as Record<string, unknown>
    if (verified === undefined) errors.push(`${file}: frontmatter missing verified`)
    else if (!VerifiedDate.safeParse(verified).success) errors.push(`${file}: frontmatter verified must be a valid YYYY-MM-DD date, got ${JSON.stringify(verified)}`)
    if (typeof title !== 'string' || title.trim() === '') errors.push(`${file}: frontmatter missing title`)
  }
}

async function readData(dir: string, file: string, errors: string[]): Promise<unknown> {
  const path = join(dir, file)
  if (!existsSync(path)) {
    errors.push(`${file}: missing`)
    return undefined
  }
  const text = await readFile(path, 'utf8')
  try {
    return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
  } catch (e) {
    errors.push(`${file}: does not parse (${(e as Error).message})`)
    return undefined
  }
}

function pushIssues(prefix: string, result: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }, errors: string[]): void {
  if (result.success || !result.error) return
  for (const issue of result.error.issues) {
    const where = issue.path.length ? `${issue.path.join('.')}: ` : ''
    errors.push(`${prefix}: ${where}${issue.message}`)
  }
}

async function lintDataFile(dir: string, file: string, schema: ZodType, errors: string[]): Promise<void> {
  const data = await readData(dir, file, errors)
  if (data !== undefined) pushIssues(file, schema.safeParse(data), errors)
}

async function lintGuardrails(dir: string, errors: string[]): Promise<void> {
  const data = await readData(dir, 'guardrails.yaml', errors)
  if (data === undefined) return
  if (!Array.isArray(data)) {
    errors.push('guardrails.yaml: must be a top-level list')
    return
  }
  data.forEach((item, i) => {
    const id = item && typeof item === 'object' && typeof item.id === 'string' ? item.id : `#${i + 1}`
    pushIssues(`guardrails.yaml ${id}`, GuardrailSchema.safeParse(item), errors)
  })
  const ids = data.map((item) => (item && typeof item === 'object' ? item.id : undefined))
  const length = Math.max(ids.length, GUARDRAIL_IDS.length)
  for (let i = 0; i < length; i++) {
    if (ids[i] !== GUARDRAIL_IDS[i]) {
      errors.push(
        `guardrails.yaml: ids must be exactly G-01..G-34 in order; at position ${i + 1} expected ${GUARDRAIL_IDS[i] ?? '(end of list)'}, found ${ids[i] ?? '(nothing)'}`,
      )
      break
    }
  }
}

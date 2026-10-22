import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import fg from 'fast-glob'
import ignore from 'ignore'

export interface ProjectFile {
  /** Path relative to the project root, always with forward slashes. */
  rel: string
  abs: string
  text: string
  /** Under src/, app/, pages/, components/, web/ or client/, and not under server/, api/, relay/ or scripts/. */
  isClient: boolean
  isTest: boolean
}

const ALWAYS_SKIP = ['node_modules', 'dist', 'build', '.git', 'coverage']
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.html', '.toml', '.env'])
const ENV_NAMES = new Set(['.env', '.env.example'])
const MAX_BYTES = 1024 * 1024
const CLIENT_DIRS = new Set(['src', 'app', 'pages', 'components', 'web', 'client'])
const SERVER_DIRS = new Set(['server', 'api', 'relay', 'scripts'])
const TEST_DIRS = new Set(['test', 'tests', '__tests__'])

function isTextFile(rel: string): boolean {
  const name = basename(rel)
  return ENV_NAMES.has(name) || TEXT_EXTS.has(extname(name))
}

function classify(rel: string): { isClient: boolean; isTest: boolean } {
  const dirs = rel.split('/').slice(0, -1)
  const isClient = dirs.some(d => CLIENT_DIRS.has(d)) && !dirs.some(d => SERVER_DIRS.has(d))
  const isTest = dirs.some(d => TEST_DIRS.has(d)) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  return { isClient, isTest }
}

async function loadGitignore(root: string) {
  const ig = ignore()
  try {
    ig.add(await readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    // no root .gitignore: nothing extra to skip
  }
  return ig
}

/**
 * Lists the project's text files. Read-only: it only stats and reads.
 * Honours the root .gitignore (nested .gitignore files are not read) and
 * always skips node_modules, dist, build, .git and coverage at any depth.
 * `include` / `exclude` are fast-glob patterns relative to `root`.
 */
export async function walkProject(root: string, opts: { include?: string[]; exclude?: string[] } = {}): Promise<ProjectFile[]> {
  const patterns = opts.include?.length ? opts.include : ['**/*']
  const skip = [...ALWAYS_SKIP.map(d => `**/${d}/**`), ...(opts.exclude ?? [])]
  const entries = await fg(patterns, { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: skip })
  const gitignore = await loadGitignore(root)

  const files: ProjectFile[] = []
  for (const rel of entries.sort()) {
    if (!isTextFile(rel) || gitignore.ignores(rel)) continue
    const abs = join(root, rel)
    if ((await stat(abs)).size > MAX_BYTES) continue
    files.push({ rel, abs, text: await readFile(abs, 'utf8'), ...classify(rel) })
  }
  return files
}

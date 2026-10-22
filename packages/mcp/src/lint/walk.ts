import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
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
 * A file that cannot be stat'ed or read (EACCES, removed mid-walk) is skipped and reported to `onSkip`;
 * so is a directory that cannot be listed (reported as `dir/`), whose contents are then not checked.
 */
export async function walkProject(
  root: string,
  opts: { include?: string[]; exclude?: string[]; onSkip?: (rel: string, reason: string) => void } = {},
): Promise<ProjectFile[]> {
  const patterns = opts.include?.length ? opts.include : ['**/*']
  const skip = [...ALWAYS_SKIP.map(d => `**/${d}/**`), ...(opts.exclude ?? [])]
  // suppressErrors: an unlistable directory must not abort the walk. fast-glob then drops it silently,
  // so directories are listed too (objectMode) and each is checked for read+search access below.
  const entries = await fg(patterns, {
    cwd: root, dot: true, onlyFiles: false, objectMode: true, followSymbolicLinks: false, ignore: skip, suppressErrors: true,
  })
  const gitignore = await loadGitignore(root)
  const report = (rel: string, e: unknown) =>
    opts.onSkip?.(rel, (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e)))

  const files: ProjectFile[] = []
  for (const { path: rel, dirent } of entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (dirent.isDirectory()) {
      if (gitignore.ignores(`${rel}/`)) continue
      await access(join(root, rel), constants.R_OK | constants.X_OK).catch(e => report(`${rel}/`, e))
      continue
    }
    if (!dirent.isFile() || !isTextFile(rel) || gitignore.ignores(rel)) continue
    const abs = join(root, rel)
    try {
      if ((await stat(abs)).size > MAX_BYTES) continue
      files.push({ rel, abs, text: await readFile(abs, 'utf8'), ...classify(rel) })
    } catch (e) {
      report(rel, e)
    }
  }
  return files
}

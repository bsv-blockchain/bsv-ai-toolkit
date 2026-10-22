import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { execa } from 'execa'
import { z } from 'zod'
import type { Config } from '../config.js'
import { errorResult, textResult, type ToolResult } from './result.js'

export const REPOS_DIR_HINT = 'BSV_REPOS_DIR is not set; run setup.sh <dir> and set BSV_REPOS_DIR=<dir>'
const SOURCE_GLOB = '*.{ts,js,py,go,rs,java}'
const SOURCE_DIRS = ['src', 'lib', 'source', '.']
const MAX_LINES = 200
const TIMEOUT_MS = 30_000

// A failed search is reported as text starting with one of these, so callers can tell it from a hit.
const NO_MATCH = 'No matches found'
const FAILED = 'Search failed'

/** The repos dir, or the repository under it; throws on an unset/missing dir or a name that leaves it. */
function searchRoot(cfg: Config, repository?: string): string {
  if (cfg.reposDir === undefined || !existsSync(cfg.reposDir)) throw new Error(REPOS_DIR_HINT)
  const root = resolve(cfg.reposDir)
  if (repository === undefined || repository === '') return root
  const dir = resolve(root, repository)
  if (!dir.startsWith(root + sep)) throw new Error(`repository_name must name a directory inside BSV_REPOS_DIR: ${repository}`)
  if (!existsSync(dir)) throw new Error(`Repository directory not found: ${dir}`)
  return dir
}

/** The executables used; tests swap `rg` for a missing command to exercise the grep fallback. */
export interface SearchCommands {
  rg: string
  grep: string
}
const DEFAULT_COMMANDS: SearchCommands = { rg: 'rg', grep: 'grep' }

/**
 * Runs ripgrep (falling back to grep when rg is not installed) in `dir`: first matching line per file, only
 * files matching `fileGlob`. Arguments go to execa as an argv array, never through a shell, so the query
 * cannot inject commands.
 */
async function runSearch(dir: string, pattern: string, fileGlob: string, commands: SearchCommands): Promise<string> {
  const opts = { cwd: dir, reject: false, timeout: TIMEOUT_MS } as const
  let r = await execa(commands.rg, ['--color=never', '--line-number', '--max-count=1', '-g', fileGlob, '-e', pattern, '.'], opts)
  if (r.failed && (r as { code?: string }).code === 'ENOENT') {
    // rg skips .git and (via .gitignore) node_modules; grep has to be told.
    const includes = expandGlob(fileGlob).map((g) => `--include=${g}`)
    r = await execa(commands.grep, ['-r', '-n', '-I', '-E', '-m', '1', '--exclude-dir=.git', '--exclude-dir=node_modules', ...includes, '-e', pattern, '.'], opts)
  }
  if (r.exitCode === 1) return `${NO_MATCH} for "${pattern}".`
  if (r.failed) return `${FAILED} for "${pattern}": ${String(r.stderr || r.shortMessage).trim()}`
  return truncate(String(r.stdout).trim()) || `${NO_MATCH} for "${pattern}".`
}

function truncate(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_LINES) return text
  return [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more lines; narrow the query or set repository_name`].join('\n')
}

// grep's --include takes no brace lists: '*.{ts,js}' → ['*.ts', '*.js']; '*' → [] (every file).
function expandGlob(glob: string): string[] {
  if (glob === '*') return []
  const m = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(glob)
  return m ? m[2].split(',').map((alt) => `${m[1]}${alt}${m[3]}`) : [glob]
}

const isHit = (text: string) => !text.startsWith(NO_MATCH) && !text.startsWith(FAILED)

// 'ts', '.ts' and '*.ts' all mean *.ts; anything already a glob passes through.
function fileGlob(ext: string | undefined): string {
  if (ext === undefined || ext === '') return '*'
  return /[*?[{]/.test(ext) ? ext : `*.${ext.replace(/^\./, '')}`
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function codeSearch(
  input: { query: string; repository_name?: string; file_extension?: string },
  cfg: Config,
  commands: SearchCommands = DEFAULT_COMMANDS,
): Promise<string> {
  const dir = searchRoot(cfg, input.repository_name)
  return prefix(await runSearch(dir, input.query, fileGlob(input.file_extension), commands), dir, cfg)
}

export async function findFunctionDefinition(
  input: { function_name: string; repository_name?: string },
  cfg: Config,
  commands: SearchCommands = DEFAULT_COMMANDS,
): Promise<string> {
  const root = searchRoot(cfg, input.repository_name)
  const name = escapeRegex(input.function_name)
  const pattern = [
    `function\\s+${name}[\\s(]`,
    `def\\s+${name}[\\s(:]`,
    `const\\s+${name}\\s*=`,
    `let\\s+${name}\\s*=`,
    `var\\s+${name}\\s*=`,
    `class\\s+\\w+\\s*\\{[^}]*${name}\\s*\\(`,
    `${name}\\s*:\\s*function`,
    `${name}\\s*\\(`,
  ].join('|')

  // Source directories first; the whole tree ('.') last.
  let results = ''
  for (const sub of SOURCE_DIRS) {
    const dir = join(root, sub)
    if (!existsSync(dir)) continue
    results = await runSearch(dir, pattern, SOURCE_GLOB, commands)
    if (isHit(results)) return prefix(results, dir, cfg)
  }
  return results
}

// Hits are relative to the directory searched; make them relative to BSV_REPOS_DIR.
function prefix(results: string, dir: string, cfg: Config): string {
  if (!isHit(results)) return results
  const rel = relative(resolve(cfg.reposDir!), dir)
  const base = rel === '' ? '' : `${rel}/`
  return results
    .split('\n')
    .map((line) => (line.startsWith('./') ? `${base}${line.slice(2)}` : line))
    .join('\n')
}

async function run(search: () => Promise<string>): Promise<ToolResult> {
  try {
    return textResult(await search())
  } catch (e) {
    return errorResult(e)
  }
}

export function registerSearchTools(server: McpServer, cfg: Config): void {
  server.registerTool(
    'code_search',
    {
      description:
        'Search the BSV repositories cloned under BSV_REPOS_DIR (by setup.sh) with ripgrep; returns the first matching line ' +
        'per file as path:line:text.',
      inputSchema: {
        query: z.string().describe('Regular expression to search for'),
        repository_name: z.string().optional().describe('Limit to one repository directory under BSV_REPOS_DIR, e.g. ts-stack'),
        file_extension: z.string().optional().describe('Limit to one file type, e.g. ts or *.go'),
      },
    },
    (input) => run(() => codeSearch(input, cfg)),
  )

  server.registerTool(
    'find_function_definition',
    {
      description:
        'Find likely definitions of a function, method or constant in the BSV repositories under BSV_REPOS_DIR ' +
        '(TypeScript, JavaScript, Python, Go, Rust, Java); searches src/, lib/ and source/ first.',
      inputSchema: {
        function_name: z.string().describe('Exact name of the function, method or constant'),
        repository_name: z.string().optional().describe('Limit to one repository directory under BSV_REPOS_DIR, e.g. ts-stack'),
      },
    },
    (input) => run(() => findFunctionDefinition(input, cfg)),
  )
}

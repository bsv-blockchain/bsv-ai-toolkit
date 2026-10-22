import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The sample's hand-off documents and deploy files: they must say what the code does, and the image must carry
// no secret. Reads only files in this repo.

const SAMPLE = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(SAMPLE, '..', '..')
// A missing file reads as '' so each test fails on its own assertion.
const readAt = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const read = (...parts: string[]) => readAt(join(SAMPLE, ...parts))
const headings = (md: string) => md.split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3).trim())

// Every rule check_guardrails runs statically on a shape-A app, plus the manual ones this app answers.
const SHAPE_A_RULES = ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-09', 'G-10', 'G-12', 'G-13', 'G-14', 'G-15', 'G-16', 'G-21', 'G-34']
const DOCS_IDS = ['get-started.quick-start-browser', 'guides.payments', 'guides.wallet-aware-apps', 'guides.services.broadcasting']
const IMAGE = 'ghcr.io/bsv-blockchain/bsv-tipping-demo'

/** The env vars server/config.ts reads (NODE_ENV is the runtime's, not the app's). */
function configEnvVars(): string[] {
  const names = new Set([...read('server', 'config.ts').matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]))
  names.delete('NODE_ENV')
  return [...names].sort()
}

describe('GUARDRAILS.md', () => {
  const md = read('GUARDRAILS.md')

  it('maps every static rule that applies to shape A', () => {
    expect(md).toContain('| id | how this app satisfies it | file |')
    for (const id of SHAPE_A_RULES) expect(md, id).toMatch(new RegExp(`^\\| ${id} \\|`, 'm'))
  })

  it('says the shape-B and contract rules do not apply and ends with the command and its expected result', () => {
    for (const id of ['G-17', 'G-18', 'G-19', 'G-23', 'G-24']) expect(md, id).toContain(id)
    expect(md).toMatch(/contract/i)
    const tail = md.trimEnd().split('\n').slice(-6).join('\n')
    expect(tail).toContain('pnpm guardrails')
    expect(tail).toContain('0 errors')
  })

  it('names files that exist', () => {
    const files = [...md.matchAll(/^\| G-\d\d \|[^|]*\| (.+) \|$/gm)].flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(f => f[1]))
    expect(files.length).toBeGreaterThanOrEqual(SHAPE_A_RULES.length)
    for (const f of files) expect(existsSync(join(SAMPLE, f)), f).toBe(true)
  })
})

describe('TRUST.md', () => {
  const md = read('TRUST.md')

  it('has the three required sections', () => {
    expect(headings(md)).toEqual(expect.arrayContaining(['Served-code trust', '0-conf stance', 'What the relay can and cannot do', 'Residual risks']))
  })

  it('names the residual risks the review rounds left open', () => {
    for (const phrase of [/remittance candidates/i, /lookalike/i, /internalizedAt/, /wallet-toolbox`? 2\.14\.9/, /\/api\/tx/, /TRUST_PROXY/]) {
      expect(md).toMatch(phrase)
    }
  })
})

describe('README.md', () => {
  const md = read('README.md')

  it('has a Trust model section (G-34) linking TRUST.md', () => {
    const section = md.split(/^## /m).find(s => s.startsWith('Trust model'))
    expect(section).toBeDefined()
    expect(section).toContain('(TRUST.md)')
  })

  it('links the hosting, guardrails and gate documents', () => {
    expect(md).toContain('(HOSTING.md)')
    expect(md).toContain('(GUARDRAILS.md)')
    expect(md).toContain('pnpm gate')
    expect(md).not.toMatch(/stub/i)
  })

  it('links the four docs pages on the live docs host, each under its docs-index id', () => {
    const index = JSON.parse(readFileSync(join(REPO, 'packages', 'mcp', 'content', 'docs-index.json'), 'utf8')) as {
      ids: Record<string, { path: string }>
    }
    for (const id of DOCS_IDS) {
      const url = `https://bsv.writedocs.io/docs/${index.ids[id].path}`
      expect(md, id).toContain(`<!-- docs_url: ${id} -->`)
      expect(md, id).toMatch(new RegExp(`<!-- docs_url: ${id.replace(/\./g, '\\.')} -->[^\\n]*\\(${url.replace(/[./]/g, '\\$&')}\\)`))
    }
    expect(md).not.toContain('docs.bsvblockchain.org')
  })
})

describe('HOSTING.md', () => {
  const md = read('HOSTING.md')

  it('has the sections the hosting team needs', () => {
    expect(headings(md)).toEqual(
      expect.arrayContaining(['Image', 'Run', 'Environment', 'Persistence', 'Reverse proxy requirements', 'Health', 'Secrets', 'Network switch']),
    )
  })

  it('names the image, the volume and the SSE no-buffer rule', () => {
    expect(md).toContain(IMAGE)
    expect(md).toContain('/data')
    expect(md).toContain('/api/events')
    expect(md).toContain('proxy_buffering off')
    expect(md).toContain('X-Accel-Buffering: no')
  })

  it('says how to try the image locally over http', () => {
    expect(md).toContain('-e NODE_ENV=development -e PUBLIC_ORIGIN=http://localhost:8080')
    expect(md).toContain('pnpm start')
  })

  it('names the manifest passthrough headers', () => {
    for (const h of ['application/manifest+json', 'Access-Control-Allow-Origin: *', 'Cache-Control: no-store']) expect(md, h).toContain(h)
  })

  it('documents every variable server/config.ts reads', () => {
    const vars = configEnvVars()
    expect(vars).toEqual(['ARCADE_URL', 'BSV_NETWORK', 'CREATOR_IDENTITY_KEY', 'DATA_DIR', 'PORT', 'PUBLIC_ORIGIN', 'TRUST_PROXY'])
    for (const v of vars) expect(md, v).toContain(`\`${v}`)
  })
})

describe('Docker image', () => {
  const dockerfile = read('Dockerfile')
  const ignore = read('Dockerfile.dockerignore')

  it('Dockerfile has no .env, no key and runs as node', () => {
    expect(dockerfile.match(/^USER node$/gm)).toHaveLength(1)
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/)
    expect(dockerfile).not.toMatch(/KEY=/)
    expect(dockerfile).not.toMatch(/\.key\b|BSV_TESTNET_GATE_KEY|BSV_GATE_KEY_FILE/)
  })

  it('Dockerfile runs the native-addon and import smoke checks and the network guard at boot', () => {
    expect(dockerfile).toContain("require('better-sqlite3')")
    expect(dockerfile).toContain("await import('./dist/server/app.js')")
    expect(dockerfile).toMatch(/^VOLUME \/data$/m)
    expect(dockerfile).toMatch(/^HEALTHCHECK /m)
    expect(dockerfile).toMatch(/^CMD \["bash", "-c", "bash scripts\/network-guard\.sh && exec node dist\/server\/index\.js"\]$/m)
  })

  it('the build context ignore file keeps secrets, data and local state out', () => {
    const lines = ignore.split('\n').map(l => l.trim())
    for (const p of ['**/.env', '**/.env.*', '**/data', '**/node_modules', '**/.git', '**/.bsv-gate', '**/*.key', '**/*.sqlite', 'docs/evals']) {
      expect(lines, p).toContain(p)
    }
  })

  it('pnpm deploy keeps the build, the manifest and only the guard script', () => {
    const pkg = JSON.parse(read('package.json')) as { files?: string[]; dependencies: Record<string, string> }
    expect(pkg.files).toEqual(['dist', 'public', 'scripts/network-guard.sh'])
    expect(Object.keys(pkg.dependencies)).not.toContain('@bsv/wallet-toolbox')
  })

  it('compose runs the published image with one named volume at /data', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain(`image: ${IMAGE}:latest`)
    expect(compose).toContain('"8080:8080"')
    expect(compose).toContain('env_file: .env')
    expect(compose).toContain('tipping-data:/data')
    expect(compose).toContain('restart: unless-stopped')
    // environment wins over env_file, so a .env copied from env.example keeps the database on the volume.
    expect(compose).toMatch(/environment:\n {6}DATA_DIR: \/data\n {6}PORT: "8080"/)
    expect(compose).toMatch(/^volumes:\n {2}tipping-data:/m)
  })
})

describe('env.example', () => {
  const env = read('env.example')
  const names = [...env.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]).sort()

  it('has no key variables', () => {
    expect(names).toEqual(configEnvVars())
    for (const n of names) expect(n).not.toMatch(/PRIVATE|WIF|SEED|MNEMONIC|SECRET|ROOT|GATE/)
    expect(env).not.toMatch(/=\s*[0-9a-f]{64}\s*$/im)
    // CREATOR_IDENTITY_KEY is a public key and ships empty.
    expect(env).toMatch(/^CREATOR_IDENTITY_KEY=$/m)
  })

  it('ships PUBLIC_ORIGIN empty, with a comment saying what to set', () => {
    expect(env).toMatch(/^PUBLIC_ORIGIN=$/m)
    const comment = env.split(/^PUBLIC_ORIGIN=/m)[0].trimEnd().split('\n').reverse()
    const block = comment.slice(0, comment.findIndex(l => !l.startsWith('#'))).join('\n')
    expect(block).toContain('https://')
    expect(block).toMatch(/production/)
  })
})

describe('GHCR workflow', () => {
  const wf = readAt(join(REPO, '.github', 'workflows', 'sample-ghcr.yml'))

  it('builds the sample image on main and v* tags only, never from a pull request', () => {
    expect(wf).not.toMatch(/pull_request/)
    expect(wf).toContain('branches: [main]')
    expect(wf).toContain("tags: ['v*']")
    for (const p of ["'samples/tipping-shape-a/**'", "'pnpm-lock.yaml'", "'package.json'", "'pnpm-workspace.yaml'", "'.github/workflows/sample-ghcr.yml'"]) {
      expect(wf, p).toContain(p)
    }
  })

  it('pushes a v* tag only when the tagged commit is on main (as release.yml does)', () => {
    expect(wf).toMatch(/fetch-depth: 0\n {10}persist-credentials: false/)
    const step = wf.split('- name: ').find(s => s.startsWith('Tagged commit is on main'))
    expect(step).toBeDefined()
    expect(step).toContain("if: startsWith(github.ref, 'refs/tags/')")
    expect(step).toContain('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main')
    expect(step).toContain('git merge-base --is-ancestor HEAD origin/main')
    // Before the registry login and the push.
    expect(wf.indexOf('Tagged commit is on main')).toBeLessThan(wf.indexOf('Log in to GHCR'))
  })

  it('pushes the image with least privilege', () => {
    expect(wf).toContain('IMAGE_NAME: bsv-blockchain/bsv-tipping-demo')
    expect(wf).toMatch(/permissions:\n {6}contents: read\n {6}packages: write/)
    expect(wf).toContain('persist-credentials: false')
    expect(wf).toContain('file: samples/tipping-shape-a/Dockerfile')
    expect(wf).toContain('platforms: linux/amd64,linux/arm64')
    expect(wf).not.toMatch(/secrets:\s*\|/) // no token handed to the build
  })
})

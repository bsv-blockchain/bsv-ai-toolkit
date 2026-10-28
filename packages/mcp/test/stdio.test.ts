import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ENTRY = fileURLToPath(new URL('../build/index.js', import.meta.url))

const TOOLS = [
  'arcade_health',
  'arcade_policy',
  'arcade_status',
  'arcade_submit',
  'brc_lookup',
  'check_guardrails',
  'code_search',
  'docs_url',
  'find_function_definition',
  'versions_check',
]

// Runs the built entry point and resolves once it exits, or once stderr has a full line (then kills it).
function runEntry(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stderr })
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`build/index.js did not exit or log within 10s; stderr so far: ${stderr}`))
    }, 10_000)
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      // A running server never exits on its own: stop it once the startup line is in.
      if (/^@bsv\/mcp v\S+ network=.*\n/.test(stderr)) {
        child.kill()
        finish(null)
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => finish(code))
  })
}

describe('stdio bootstrap', () => {
  beforeAll(() => {
    if (!existsSync(ENTRY)) {
      throw new Error(`${ENTRY} is missing: run \`pnpm -F @bsv/mcp build\` before this test`)
    }
  })

  it('starts over stdio without BSV_REPOS_DIR and lists 10 tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { PATH: process.env.PATH ?? '', BSV_NETWORK: 'testnet' },
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    const client = new Client({ name: 'stdio-test', version: '0.0.0' })
    try {
      await client.connect(transport)
      const info = client.getServerVersion()
      expect(info?.name).toBe('@bsv/mcp')
      expect(info?.version).toBe('2.0.0')
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS)
      expect(stderr).toContain(
        '@bsv/mcp v2.0.0 network=testnet arcade=https://arcade-testnet-us-1.bsvblockchain.tech repos=unset\n',
      )
    } finally {
      await client.close()
    }
  })

  it('rejects BSV_NETWORK=main with exit code 1', async () => {
    const { code, stderr } = await runEntry({ PATH: process.env.PATH ?? '', BSV_NETWORK: 'main' })
    expect(code).toBe(1)
    expect(stderr).toContain('BSV_NETWORK must be "testnet" or "mainnet", got "main"')
  })

  it('never prints ARCADE_URL userinfo, path or query', async () => {
    const started = await runEntry({
      PATH: process.env.PATH ?? '',
      ARCADE_URL: 'https://user:s3cret@arcade-testnet-us-1.bsvblockchain.tech/p/s3cret?key=s3cret',
      BSV_REPOS_DIR: '/tmp/repos-s3cret',
      WOC_API_KEY: 's3cret',
    })
    expect(started.stderr).toContain(
      'network=testnet arcade=https://arcade-testnet-us-1.bsvblockchain.tech repos=set\n',
    )
    expect(started.stderr).not.toContain('s3cret')

    const failed = await runEntry({ PATH: process.env.PATH ?? '', ARCADE_URL: 'https://user:s3cret@[bad/p' })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('invalid arcadeUrl')
    expect(failed.stderr).not.toContain('s3cret')
  })
})

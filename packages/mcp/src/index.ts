#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, type Config } from './config.js'
import { createServer } from './server.js'

// protocol//host[:port] only, so userinfo, path and query never reach a log.
function origin(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '<invalid url>'
  }
}

// Replaces the raw BSV_BROADCASTER_URL (or the deprecated ARCADE_URL) and any other URL in a config error message
// with its origin.
function redact(message: string, env: NodeJS.ProcessEnv): string {
  let out = message
  for (const raw of [env.BSV_BROADCASTER_URL, env.ARCADE_URL]) if (raw) out = out.split(raw).join(origin(raw))
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, origin)
}

let cfg: Config
try {
  cfg = loadConfig(process.env)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`@bsv/mcp: config error: ${redact(message, process.env)}`)
  process.exit(1)
}

const server = createServer(cfg)
await server.connect(new StdioServerTransport())
console.error(
  `@bsv/mcp v${cfg.version} network=${cfg.network} broadcaster=${origin(cfg.broadcasterUrl)} repos=${cfg.reposDir ? 'set' : 'unset'}`,
)

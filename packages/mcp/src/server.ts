import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from './config.js'
import { registerArcadeTools } from './tools/arcade.js'
import { registerGuardrailTools } from './tools/guardrails.js'

// Builds the server and registers every tool, resource and prompt. Transport is the caller's concern.
export function createServer(cfg: Config, deps: { fetchImpl?: typeof fetch } = {}): McpServer {
  const server = new McpServer({ name: '@bsv/mcp', version: cfg.version })
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  registerArcadeTools(server, cfg, fetchImpl)
  registerGuardrailTools(server, cfg)
  return server
}

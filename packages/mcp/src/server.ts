import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from './config.js'
import { registerPrompts } from './prompts/index.js'
import { registerResources } from './resources/index.js'
import { registerArcadeTools } from './tools/arcade.js'
import { registerBrcTools } from './tools/brc.js'
import { registerDocsTools } from './tools/docs.js'
import { registerGuardrailTools } from './tools/guardrails.js'
import { registerSearchTools } from './tools/search.js'
import { registerVersionsTools } from './tools/versions.js'

// Builds the server and registers every tool, resource and prompt. Transport is the caller's concern.
export function createServer(cfg: Config, deps: { fetchImpl?: typeof fetch } = {}): McpServer {
  const server = new McpServer({ name: '@bsv/mcp', version: cfg.version })
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  registerArcadeTools(server, cfg, fetchImpl)
  registerGuardrailTools(server, cfg)
  registerBrcTools(server, cfg, fetchImpl)
  registerDocsTools(server, fetchImpl)
  registerVersionsTools(server, fetchImpl)
  registerSearchTools(server, cfg)
  registerResources(server, cfg, fetchImpl)
  registerPrompts(server)
  return server
}

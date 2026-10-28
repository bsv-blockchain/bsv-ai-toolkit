#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const INSTALL = 'claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp'
const URI = 'simple://deprecated'

const NOTICE = `# @bsv/simple-mcp is deprecated

This server no longer serves the \`@bsv/simple\` reference or code generators. Its content now lives in
[\`@bsv/mcp\`](https://www.npmjs.com/package/@bsv/mcp) 2.x ([source](https://github.com/bsv-blockchain/bsv-ai-toolkit)).

Install it, testnet first:

\`\`\`bash
${INSTALL}
\`\`\`

Then remove this server: \`claude mcp remove simple-mcp\`.

Where things moved in \`@bsv/mcp\`:

- Resource \`bsv://simple/api\`: the \`@bsv/simple\` API surface.
- Resource \`bsv://simple/gotchas\`: \`@bsv/simple\` traps and what to do instead.
- Prompt \`integrate_simple\`: add \`@bsv/simple\` to a Next.js, Express, React or Node project.
- Prompt \`add_simple_feature\` (was \`add_bsv_feature\`): add payments, tokens, inscriptions, MessageBox, certificates, DID or overlay support.
- Prompt \`debug_simple\`: diagnose a \`@bsv/simple\` problem against the known gotchas.

The \`scaffold_nextjs_config\` and \`generate_*\` tools have no replacement: the prompts guide your agent to write the code.
`

const server = new McpServer({ name: '@bsv/simple-mcp', version: '0.0.3' })

server.registerResource(
  'deprecated',
  URI,
  { title: '@bsv/simple-mcp is deprecated', description: 'Use @bsv/mcp instead', mimeType: 'text/markdown' },
  async () => ({ contents: [{ uri: URI, mimeType: 'text/markdown', text: NOTICE }] }),
)

console.error(`@bsv/simple-mcp is deprecated. Install @bsv/mcp: ${INSTALL}`)

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error('@bsv/simple-mcp failed to start:', error)
  process.exit(1)
})

// The shape every tool handler returns, and the helpers that build it.
export type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

export function textResult(text: string, structured?: unknown): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }] }
  if (structured !== undefined) result.structuredContent = structured as Record<string, unknown>
  return result
}

export function errorResult(error: unknown): ToolResult {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
}

/** Runs `run`; its value becomes JSON text plus structuredContent, a throw becomes an isError result. */
export async function respond(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await run()
    return textResult(JSON.stringify(result, null, 2), result)
  } catch (e) {
    return errorResult(e)
  }
}

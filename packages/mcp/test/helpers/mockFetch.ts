export interface MockRoute {
  method: string
  path: RegExp
  status: number
  body: any
  delayMs?: number
}

export interface MockCall {
  method: string
  url: string
  path: string
  headers: Record<string, string>
  body: string | undefined
  signal: AbortSignal | undefined
}

export type MockFetch = typeof fetch & { calls: MockCall[] }

// A fetch stand-in. `path` is matched against the URL pathname. Matching routes answer in order, one call
// each; once all have answered, the last matching route keeps answering. No match throws (like a network error).
// A string body is sent as-is; anything else as JSON. delayMs honours init.signal, so timeouts can be tested.
export function mockFetch(routes: MockRoute[]): MockFetch {
  const calls: MockCall[] = []
  const used = new Set<MockRoute>()
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const signal = init.signal ?? undefined
    calls.push({ method, url: url.toString(), path: url.pathname, headers, body: typeof init.body === 'string' ? init.body : undefined, signal })
    const matching = routes.filter((r) => r.method.toUpperCase() === method && r.path.test(url.pathname))
    const route = matching.find((r) => !used.has(r)) ?? matching.at(-1)
    if (!route) throw new TypeError(`mockFetch: no route for ${method} ${url.pathname}`)
    used.add(route)
    if (route.delayMs) await delay(route.delayMs, signal)
    signal?.throwIfAborted()
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(text, { status: route.status, headers: { 'content-type': 'application/json' } })
  }
  return Object.assign(impl as typeof fetch, { calls })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

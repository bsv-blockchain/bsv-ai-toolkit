// WhatsOnChain only for what Arcade cannot answer (tip height), behind one process-wide gate.
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/test'
const GAP_MS = 350

let gate: Promise<unknown> = Promise.resolve()

/** Runs `task` after the previous WhatsOnChain call, then holds the gate for GAP_MS. */
function gated<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.then(task)
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, GAP_MS))
  gate = run.then(pause, pause)
  return run
}

export async function tipHeight(): Promise<number> {
  const res = await gated(() => fetch(`${WOC_BASE}/chain/info`, { signal: AbortSignal.timeout(10000) }))
  const { blocks } = (await res.json()) as { blocks: number }
  return blocks
}

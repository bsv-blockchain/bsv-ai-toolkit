import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Arcade } from './arcade.js'
import type { ServerConfig } from './config.js'
import type { Db } from './db.js'
import { mountApi, type Limits } from './routes.js'
import { Broadcaster } from './sse.js'

export interface AppDeps {
  db: Db
  arcade: Arcade
  /** SSE fan-out for /api/events. Default: a new Broadcaster. */
  broadcaster?: Broadcaster
  /** The built web app. Default: dist/web under the sample root. */
  webDir?: string
  /** Overrides for the API's rate limit, caps and pruning (tests). */
  limits?: Partial<Limits>
  /** The API's clock in ms (tests). Default Date.now. */
  now?: () => number
}

// The sample root: one level above server/ (tsx, vitest), two above dist/server/ (built).
const here = dirname(fileURLToPath(import.meta.url))
const up = resolve(here, '..')
export const SAMPLE_ROOT = basename(up) === 'dist' ? resolve(up, '..') : up

const VERSION: string = JSON.parse(readFileSync(join(SAMPLE_ROOT, 'package.json'), 'utf8')).version
const MANIFEST_PATH = join(SAMPLE_ROOT, 'public', 'manifest.json')

/**
 * One origin for everything the wallet sees: /manifest.json, the web app and /api share it, so the
 * manifest's origin is the `originator` the app passes to WalletClient.
 */
export function createApp(cfg: ServerConfig, deps: AppDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  // Behind the reverse proxy HOSTING.md requires, req.ip must be the client, not the proxy, or the per-address
  // rate limit becomes one global bucket. TRUST_PROXY (default: loopback, link-local and private-network peers)
  // says whose X-Forwarded-For to believe; see DEFAULT_TRUST_PROXY in config.ts.
  app.set('trust proxy', cfg.trustProxy)

  // The Arcade origin only: an ARCADE_URL may carry credentials or a private path, and /health is public.
  const arcadeOrigin = new URL(cfg.arcadeUrl).origin
  app.get('/health', (_req, res) => {
    res.json({ ok: true, network: cfg.network, arcadeOrigin, version: VERSION })
  })

  // Before express.static and the SPA fallback, so these headers always apply. Wallets fetch the manifest
  // cross-origin and must see edits at once.
  app.get('/manifest.json', (_req, res) => {
    res.set({
      'Content-Type': 'application/manifest+json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.send(readFileSync(MANIFEST_PATH))
  })

  // /api answers JSON only (unknown paths are a JSON 404), so it never reaches the SPA fallback.
  mountApi(app, cfg, { db: deps.db, arcade: deps.arcade, broadcaster: deps.broadcaster ?? new Broadcaster(), limits: deps.limits, now: deps.now })

  const webDir = deps.webDir ?? join(SAMPLE_ROOT, 'dist', 'web')
  const indexHtml = join(webDir, 'index.html')
  app.use(express.static(webDir, { index: false }))
  // SPA fallback: every other GET gets the app shell; the client routes on window.location.pathname.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (!existsSync(indexHtml)) return res.status(404).type('text/plain').send('web app not built: run pnpm build')
    res.sendFile(indexHtml)
  })

  return app
}

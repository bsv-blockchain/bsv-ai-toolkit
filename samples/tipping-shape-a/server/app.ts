import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { ServerConfig } from './config.js'

export interface AppDeps {
  /** The built web app. Default: dist/web under the sample root. */
  webDir?: string
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
export function createApp(cfg: ServerConfig, deps: AppDeps = {}): express.Express {
  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => {
    res.json({ ok: true, network: cfg.network, arcadeUrl: cfg.arcadeUrl, version: VERSION })
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

  // Task 2 mounts the /api routes here.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

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

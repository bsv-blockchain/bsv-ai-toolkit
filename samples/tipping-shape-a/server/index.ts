import { createApp } from './app.js'
import { loadServerConfig, type ServerConfig } from './config.js'

// Refuses to start on a bad BSV_NETWORK, a mismatched ARCADE_URL or a missing PUBLIC_ORIGIN in production.
let cfg: ServerConfig
try {
  cfg = loadServerConfig()
} catch (e) {
  console.error(`bsv-tipping-demo: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

createApp(cfg).listen(cfg.port, () => {
  console.log(`bsv-tipping-demo relay on :${cfg.port} network=${cfg.network} arcade=${cfg.arcadeUrl} origin=${cfg.publicOrigin}`)
})

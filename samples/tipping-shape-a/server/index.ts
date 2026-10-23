import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app.js'
import { Arcade } from './arcade.js'
import { bootLine, loadServerConfig, type ServerConfig } from './config.js'
import { openDb, type Db } from './db.js'

// Refuses to start on a bad BSV_NETWORK, a mismatched ARCADE_URL, or in production a missing, http: or loopback
// PUBLIC_ORIGIN.
let cfg: ServerConfig
try {
  cfg = loadServerConfig()
} catch (e) {
  console.error(`bsv-tipping-demo: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

mkdirSync(cfg.dataDir, { recursive: true })
// Refuses a tips.sqlite of another schema version (nothing migrates it; the message says what to delete).
let db: Db
try {
  db = openDb(join(cfg.dataDir, 'tips.sqlite'))
} catch (e) {
  console.error(`bsv-tipping-demo: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
const server = createApp(cfg, { db, arcade: new Arcade(cfg.arcadeUrl) }).listen(cfg.port, () => {
  console.log(bootLine(cfg))
})

// Open SSE streams never end on their own, so close every connection, then the database.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
    server.closeAllConnections()
  })
}

/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The relay (server/index.ts, PORT 8080) owns /manifest.json, /api and /health; in dev Vite proxies them so the
// browser sees one origin, as in production. publicDir is off: the relay serves public/manifest.json with its headers.
const relay = `http://localhost:${process.env.PORT || 8080}`

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: { outDir: 'dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': relay, '/manifest.json': relay, '/health': relay },
  },
  test: { include: ['test/**/*.test.ts'] },
})

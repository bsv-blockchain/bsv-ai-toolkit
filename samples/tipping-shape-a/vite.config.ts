/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The relay (server/index.ts, PORT 8080) owns /manifest.json, /api and /health; in dev Vite proxies them so the
// browser sees one origin, as in production. publicDir is off: the relay serves public/manifest.json with its headers.
// PORT as the relay sees it: the shell first, then .env (pnpm dev starts the relay with --env-file-if-exists=.env).
export default defineConfig(({ mode }) => {
  const relay = `http://localhost:${loadEnv(mode, process.cwd(), '').PORT || 8080}`
  return {
    plugins: [react()],
    publicDir: false,
    build: { outDir: 'dist/web', emptyOutDir: true },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': relay, '/manifest.json': relay, '/health': relay },
    },
    test: { include: ['test/**/*.test.ts'] },
  }
})

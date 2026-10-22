# bsv-tipping-demo: one container, one origin. The relay serves the web app, /manifest.json, /api and /health.
# Build from the repo root: docker build -f samples/tipping-shape-a/Dockerfile -t bsv-tipping-demo:local .
# Nothing secret goes in: the relay holds no key, and Dockerfile.dockerignore keeps .env, data and keys out.

FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# The workspace manifests first, so the dependency layer is cached until the lockfile changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY samples/tipping-shape-a/package.json samples/tipping-shape-a/
RUN pnpm install --frozen-lockfile --filter bsv-tipping-demo...
COPY samples/tipping-shape-a/ samples/tipping-shape-a/
RUN pnpm -F bsv-tipping-demo build
# Production dependencies plus package.json "files" (dist, public, scripts/network-guard.sh): no gate scripts,
# no wallet-toolbox (a devDependency). --legacy: pnpm 10+ deploys without it only with inject-workspace-packages,
# which this workspace does not set (the sample has no workspace dependencies to inject).
RUN pnpm -F bsv-tipping-demo deploy --prod --legacy /out

FROM node:22-alpine AS runtime
RUN apk add --no-cache bash wget
WORKDIR /app
COPY --from=build /out ./
# better-sqlite3 ships linuxmusl prebuilds; opening a database loads the addon (require alone does not).
RUN node -e "new (require('better-sqlite3'))(':memory:').close()"
# Import smoke test (G-32): the built server's module graph resolves with production dependencies only.
RUN node --input-type=module -e "await import('./dist/server/app.js')"
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 BSV_NETWORK=testnet
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
# The boot guard checks BSV_NETWORK, then the relay replaces the shell so it receives SIGTERM.
CMD ["bash", "-c", "bash scripts/network-guard.sh && exec node dist/server/index.js"]

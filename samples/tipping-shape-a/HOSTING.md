# Hosting bsv-tipping-demo

One container serves everything on one origin: the web app, `/manifest.json`, `/api` and `/health`. That origin is the wallet originator, so it must be the exact public URL people open. The relay holds no key and signs nothing; tippers and the creator sign in their own wallets.

## Image

`ghcr.io/bsv-blockchain/bsv-tipping-demo`, for `linux/amd64` and `linux/arm64`, built by `.github/workflows/sample-ghcr.yml` on every push to `main` that touches this sample and on every `v*` tag.

| Tag | Points at |
| --- | --- |
| `latest` | the newest build from `main` |
| `sha-<short sha>` | one commit; pin this in a deployment so the served code changes only when you change the tag |
| `<major>.<minor>.<patch>`, `<major>.<minor>` | a `v*` release tag of this repository (the kit's release version, not a version of this sample) |

The image runs as the unprivileged `node` user, keeps its data in one volume at `/data`, and checks `BSV_NETWORK` with `scripts/network-guard.sh` before the relay starts. Its build checks that the SQLite addon loads and that the server's modules import with production dependencies only.

## Run

```bash
cp env.example .env     # then set PUBLIC_ORIGIN, and CREATOR_IDENTITY_KEY on any public host
docker compose up -d    # docker-compose.yml in this folder
```

```yaml
services:
  tipping:
    image: ghcr.io/bsv-blockchain/bsv-tipping-demo:latest
    ports: ["8080:8080"]
    env_file: .env
    environment:
      DATA_DIR: /data
      PORT: "8080"
    volumes: ["tipping-data:/data"]
    restart: unless-stopped

volumes:
  tipping-data:
```

The relay listens on port 8080 inside the container. The compose file pins `DATA_DIR` and `PORT`, so a `.env` copied from `env.example` (which has the local-development values `./data` and `8080`) cannot move the database off the volume. Without compose:

```bash
docker run -d --name tipping -p 8080:8080 -v tipping-data:/data \
  -e PUBLIC_ORIGIN=https://tipping.example.com -e CREATOR_IDENTITY_KEY=<creator identity public key> \
  ghcr.io/bsv-blockchain/bsv-tipping-demo:latest
```

The image sets `NODE_ENV=production`, so the relay refuses to start without `PUBLIC_ORIGIN`, or with one that is `http:` or a loopback host (`localhost`, `127.0.0.1`, `[::1]`). It also refuses an unknown `BSV_NETWORK`, an `ARCADE_URL` that belongs to the other network, mainnet without `CREATOR_IDENTITY_KEY`, and a `tips.sqlite` of another schema version. In each case it prints the reason and exits.

To try the image on your own machine over plain http, add `-e NODE_ENV=development -e PUBLIC_ORIGIN=http://localhost:8080` to the `docker run` above (never on a public host), or run the sample with `pnpm start` instead (see [README.md](README.md)).

## Environment

None of these is a secret. `env.example` lists the same variables.

| Variable | Value |
| --- | --- |
| `BSV_NETWORK` | `testnet` (the image default) or `mainnet`. The one network switch; see [Network switch](#network-switch). |
| `ARCADE_URL` | Optional. Empty means the public Arcade for the network (testnet `https://arcade-testnet-us-1.bsvblockchain.tech`, mainnet `https://arcade-us-1.bsvblockchain.tech`). The relay is the only part that talks to Arcade, so a private Arcade URL works. |
| `PUBLIC_ORIGIN` | Required: `https://<host>`, the exact origin people open (scheme, host, and port if it is not the default). The manifest is served there, and the creator's signatures name it (`claim:<origin>:…`, `internalized:<origin>:…`), so a signature made for one deployment is refused by another. Set it to the proxy's public origin, never to the container's address. |
| `CREATOR_IDENTITY_KEY` | The creator's identity public key: 33-byte compressed, 66 hex characters starting `02` or `03`. Required on mainnet. On testnet it is optional: when it is empty, the first wallet that claims `/creator` (signing the claim with its identity key) becomes the creator, and that choice is kept in the database. Set it on any public host, or whoever opens `/creator` first receives the tips. |
| `TRUST_PROXY` | Which peers may set `X-Forwarded-For`, so the relay sees each client's own address for its rate limits. Empty (the default) trusts loopback, link-local and private-network peers, which covers a proxy on the same host or in the same compose network. Set it to the proxy's address or subnet (comma-separated), a hop count, or `false` when nothing sits in front of the relay. If the proxy reaches the relay from a public address that is not listed, every client shares the proxy's rate-limit bucket. If the relay is reachable from a private network without the proxy, a client there can claim any address. |
| `PORT` | Default `8080`. Leave it; compose pins it. |
| `DATA_DIR` | Default `/data` in the image. Leave it; compose pins it. |

The relay's limits are fixed in code, not set by environment variables. Change the code to change them:

| Limit | Value | Where |
| --- | --- | --- |
| `POST /api/tips` per client address (IPv4 address, or IPv6 /64) | burst 5, then 10 a minute | `server/routes.ts` `DEFAULT_LIMITS` |
| `GET /api/tips/:txid/status`, `GET /api/tx/:txid` and `POST /api/tips/:txid/rebroadcast` per client address, one shared bucket | burst 30, then 120 a minute | `server/routes.ts` |
| Request body | 256 kB | `server/routes.ts` `BODY_LIMIT` |
| Remittance candidates per tip | 64 | `server/routes.ts` |
| Tips kept | 5,000; terminal tips are deleted after 24 hours without an update | `server/routes.ts` |
| All stored BEEFs together | 256 MiB; a tip past it gets 503 with `Retry-After` | `server/routes.ts` `beefBytesBudget` |
| `/api/events` streams | 200 in all, 4 per client address; a stream more than 64 KiB behind is dropped (the browser reconnects) | `server/sse.ts` |

## Persistence

One volume at `/data`, owned by the `node` user. It holds `tips.sqlite` and its WAL files: the tips, their remittance candidates and BEEFs, and the claimed creator key when `CREATOR_IDENTITY_KEY` is unset. Allow about 1 GiB; the BEEF budget above bounds the largest part. Back it up if losing tips that are still waiting to be collected matters. Tippers' browsers keep their own copy until the relay has a tip, and a collected tip is in the creator's wallet, not here.

Run one container per volume: SQLite is a single-writer file and the rate limits and event streams are in memory. Use a new volume when you change `BSV_NETWORK`.

## Reverse proxy requirements

- **HTTPS.** Wallets need a secure originator, and the page needs a secure context. Terminate TLS at the proxy and forward plain HTTP to port 8080.
- **Do not buffer `/api/events`.** It is a server-sent event stream. The relay sends `X-Accel-Buffering: no`, which nginx honours; with other proxies, turn buffering off for that path (nginx: `proxy_buffering off`). Keep the read timeout above the relay's 15-second keepalive (60 s or more), and allow HTTP/1.1 keep-alive upstream.
- **Pass `/manifest.json` through untouched.** No rewrite to the app shell, no caching, no header changes: wallets fetch it cross-origin and read the permissions from it. The relay already answers with `Content-Type: application/manifest+json`, `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`.
- **Allow slow tip posts.** `POST /api/tips` waits up to 15 s for Arcade to see the transaction before it answers. A 60-second upstream timeout covers it.
- **Forward the client address** in `X-Forwarded-For`, and set `TRUST_PROXY` to match how the proxy reaches the relay (see [Environment](#environment)).
- Serve everything from the one origin in `PUBLIC_ORIGIN`. No path prefix: the app, `/api` and `/manifest.json` sit at the root.

A minimal nginx location for the stream:

```nginx
location /api/events {
  proxy_pass http://tipping:8080;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 3600s;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Health

`GET /health` answers `{"ok":true,"network":"testnet","arcadeOrigin":"…","version":"…"}`. The image's `HEALTHCHECK` calls it every 30 s. It shows the process is serving and which network it runs on. It does not check Arcade.

Anyone who can reach `/health` sees the Arcade origin (scheme, host and port of `ARCADE_URL`); its path, query and any credentials are never shown.

## Secrets

None. No private key, seed or coin lives on the server, in the image or in `.env`. The relay cannot spend or sign. `CREATOR_IDENTITY_KEY` is a public key. The testnet gate's key (`pnpm gate`) belongs to CI and never goes on a host. See [TRUST.md](TRUST.md) for what the relay can and cannot do.

## Network switch

`BSV_NETWORK=mainnet` is the only switch. Mainnet also requires `CREATOR_IDENTITY_KEY`, and `ARCADE_URL` must be empty or a mainnet Arcade. At boot, both the network guard and the relay print the banner:

```text
**************************************************
*** MAINNET: real money. BSV_NETWORK=mainnet ***
**************************************************
```

On testnet the guard prints `network: testnet`. Both sides check the network: the app refuses to tip or collect when the user's wallet is on the other network.

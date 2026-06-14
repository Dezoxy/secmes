# Local development (Docker, no Azure)

Run the whole stack on your machine with Docker Compose — the **same** Compose stack that runs in production on the single Azure VM, just with local backing services (MinIO standing in for Backblaze B2) and dev secrets.

## Prerequisites

- Docker Desktop (or Docker Engine) running
- Node + pnpm (via `corepack enable`) — only if you want to run the app on the host instead of in a container

## Start / stop

```bash
make up                    # build + start postgres, redis, minio, zitadel (+ provision OIDC)
make migrate && make seed  # apply the schema + seed the dev tenant
make api-dev               # run the API on the host (:3000)
make ps                    # status
make logs                  # tail logs
make down                  # stop (keeps data)
make reset                 # stop + wipe data volumes
```

The API runs on the host via `make api-dev` — the Compose `api` service is `app`-profile-gated, so `make up` does **not** start it. One-time: add `127.0.0.1 zitadel` to `/etc/hosts` (see [`local-auth.md`](local-auth.md)).

## What you get

| URL | Service |
|---|---|
| http://localhost:3000/healthz | api health probe (after `make api-dev`) |
| http://localhost:3000/docs | Swagger UI (dev only; after `make api-dev`) |
| http://localhost:9001 | MinIO web console (user/pass: `argus` / `argus_local_dev`) |
| localhost:5432 | Postgres (`argus` / `argus_local_dev`, db `argus`) |
| localhost:6379 | Redis |

## Service mapping (local → production)

Production is the **same Compose stack** on the single Azure VM, so the mapping is nearly 1:1:

| Local (Compose) | Production (VM, Docker Compose) |
|---|---|
| `postgres` | self-hosted Postgres (same image) on the VM |
| `redis` | self-hosted Redis (same image) on the VM |
| `minio` | Backblaze B2 (S3-compatible) |
| `api` (built image) | `api` container on the VM (same image) |

Production runs from a separate **`compose.prod.yaml`** (standalone — not layered over this file): self-hosted Postgres + Redis, the `api`, a Caddy single-origin router that serves the PWA + proxies `/api`,`/ws`, and a cloudflared tunnel. The differences are config (B2 vs MinIO, Cloudflare Tunnel ingress, Key Vault secrets, no published ports), not architecture. See `docs/deploy.md`. This file (`compose.yaml`) stays the local-dev source.

## Develop against it from the host (hot reload)

`make api-dev` runs the API on the host in watch mode (Nest `--watch`) against the Docker backing services. For the PWA with hot reload:

```bash
pnpm --filter @argus/web dev   # Vite dev server on http://localhost:5173
```

## Notes

- All credentials here are **local-only throwaway values**, never real secrets.
- **Zitadel (identity)** runs as part of `make up` (its own DB + Login V2, provisioned by `make auth-provision`), so local login uses the real OIDC flow — see [`local-auth.md`](local-auth.md). Demo mode (auth stubbed) only applies when OIDC is left unconfigured.
- Data persists in named volumes (`pgdata`, `miniodata`) across `make down`; use `make reset` to start clean.

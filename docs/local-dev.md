# Local development (Docker, no Azure)

Run the whole stack on your machine with Docker Compose — the **same** Compose stack that runs in production on the single Azure VM, just with local backing services (MinIO standing in for Backblaze B2) and dev secrets.

## Prerequisites

- Docker Desktop (or Docker Engine) running
- Node + pnpm (via `corepack enable`) — only if you want to run the app on the host instead of in a container

## Start / stop

```bash
make up      # build + start postgres, redis, minio, api
make ps      # status
make logs    # tail logs
make down    # stop (keeps data)
make reset   # stop + wipe data volumes
```

## What you get

| URL | Service |
|---|---|
| http://localhost:3000/healthz | api health probe |
| http://localhost:3000/docs | Swagger UI (dev only) |
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

Production will run the same services from a `compose.prod.yaml` (added with the VM deploy track) — the differences will be config (B2 vs MinIO, Cloudflare Tunnel ingress, Key Vault secrets), not architecture. Until then, `compose.yaml` is the single source.

## Develop against it from the host (hot reload)

Prefer editing with live reload? Run the backing services in Docker and the app on the host:

```bash
make up                       # postgres/redis/minio (api also starts; ignore or `docker compose stop api`)
pnpm --filter @argus/api dev # nest watch on the host, pointing at localhost services
```

## Notes

- All credentials here are **local-only throwaway values**, never real secrets.
- **Zitadel (identity)** is added under a `--profile auth` at Phase 1 (checkpoint 9). Until then, auth is stubbed locally.
- Data persists in named volumes (`pgdata`, `miniodata`) across `make down`; use `make reset` to start clean.

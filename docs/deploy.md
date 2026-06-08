# Production deploy (single Azure VM)

How the production stack runs on the single Azure VM (`germanywestcentral`). **Status: built, not yet
deployed.** The infrastructure exists as code across slices; CD (`vars.ENABLE_DEPLOY`) is still off.

- **Slice 1** — VM + network + Key Vault + Managed Identity + GitHub-OIDC deploy role (`infra/vm/terraform/`).
- **Slice 2** — the prod runtime topology: `compose.prod.yaml`, the Caddy single-origin router
  (`infra/vm/caddy/`), and the cloudflared tunnel.
- **Slice 3 (this)** — Key Vault → credential files: `argus-secrets.service` fetches secrets via the Managed
  Identity into `/run/argus/secrets/` (tmpfs) — `infra/vm/secrets/`.
- **Slice 4** — CD: build/scan/sign the images, then `az vm run-command` rollout + migrate-on-deploy.

## Topology

```
users ─HTTPS─▶ Cloudflare edge (TLS · WAF · rate-limit) ─tunnel─▶ cloudflared ─▶ caddy:8080
               caddy serves the PWA + reverse-proxies /api,/ws → api:3000
               api ─▶ postgres / redis (internal Docker network, NO published ports)
               api ─▶ Backblaze B2 (egress, presigned)
```

The VM opens **no inbound port** (NSG denies all inbound; `infra/vm/terraform/`). The only way in is the
**outbound** Cloudflare tunnel. TLS, WAF, and the edge rate-limit live at Cloudflare; Caddy speaks plain HTTP
on a non-privileged port over the internal Docker network only. Threat model:
`docs/threat-models/vm-ingress.md`.

## The stack (`compose.prod.yaml`)

Standalone prod stack — **not** layered over `compose.yaml` (that file is local-dev only). Services:
`postgres`, `redis`, `api`, `caddy` (PWA + router), `cloudflared`. No `minio` (prod uses Backblaze B2). No
service publishes a host port. Every service runs hardened (non-root where the image allows,
`no-new-privileges`, `cap_drop: [ALL]`, resource limits).

> Self-hosted **Zitadel** on the VM is roadmap checkpoint 9 (Phase 1). It joins this stack there, behind
> Caddy + Cloudflare Access on an admin subdomain. Until then the prod `api` has no OIDC issuer wired.

### Images

`api` and `caddy` are **pulled by tag**, not built on the VM — `cd.yml` builds, scans (Trivy), and signs
(cosign) them, and sets `ARGUS_API_IMAGE` / `ARGUS_INGRESS_IMAGE` to the registry digest (Slice 4). To build
the ingress image locally for verification:

```bash
docker build -f infra/vm/caddy/Dockerfile -t argus-ingress:local .   # context = repo root
docker compose -f compose.prod.yaml config -q                         # validate the stack
```

## Cloudflare tunnel ingress (dashboard-managed)

cloudflared uses a **token** tunnel (the token stored in Key Vault as `argus-tunnel-token`). Ingress
hostnames are configured in the Cloudflare Zero Trust dashboard, not in this repo:

- `4rgus.com` → `http://caddy:8080`  (the app — PWA + `/api` + `/ws`, all same-origin)
- admin subdomains (e.g. ops/identity) → their service, **gated by Cloudflare Access** (identity at the edge)

## Secrets (Key Vault → credential files — Slice 3)

No secret values live in the repo. `argus-secrets.service` fetches them from Azure Key Vault via the VM's
Managed Identity into `/run/argus/secrets/` (tmpfs, `0400` root) at boot — see
[`infra/vm/secrets/`](../infra/vm/secrets/README.md). The stack consumes them as **mounted credential files**
(Docker secrets at `/run/secrets/*`), which the app reads via `*_FILE` env vars (invariant #5 — never the
value in env). Compose's secret sources point at `${ARGUS_SECRETS_DIR}` (`/run/argus/secrets` in prod,
`./secrets` in local dev):

- `secrets/postgres_password` → Postgres reads it via `POSTGRES_PASSWORD_FILE` (the **owner** account, for
  init + migrations).
- `secrets/database_url` → the api reads it via `DATABASE_URL_FILE`. This DSN **must** use the non-bypass
  runtime role `argus_app` (`postgres://argus_app:<pw>@postgres:5432/argus`), **not** the `argus` owner — so
  RLS and grants still bind on any query path that misses `SET LOCAL ROLE` or under app compromise. Slice 3
  grants `argus_app` LOGIN + a Key Vault password (migration 0001 creates it NOLOGIN); the owner credential
  stays separate, used only for migrations (Slice 4 `MIGRATION_DATABASE_URL`).
- `secrets/s3_secret_access_key` → the api reads it via `S3_SECRET_ACCESS_KEY_FILE` (the B2 key secret).

The **`TUNNEL_TOKEN`** is the one secret that can't be a mounted file — the cloudflared image has no shell and
no `--token-file` flag. Invariant #5 also permits a **runtime-fetched value**, so it's injected from the
deploy environment (`environment: TUNNEL_TOKEN`), never an on-disk env file.

Set the actual values in Key Vault once (the `az keyvault secret set` commands + the full name→file→consumer
table are in [`infra/vm/secrets/README.md`](../infra/vm/secrets/README.md)). Non-secret config (B2
endpoint/region/bucket + access-key-**id**, the API's OIDC issuer/audience, the PWA's build-time
`VITE_OIDC_*`, image tags) is in `.env.prod.example` — copy it into the deploy environment. The `secrets/`
directory (local dev) is gitignored; nothing is committed or baked into an image.

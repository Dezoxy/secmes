# Production deploy (single Azure VM)

How the production stack runs on the single Azure VM (`germanywestcentral`). **Status: built, not yet
deployed.** The infrastructure exists as code across slices; CD (`vars.ENABLE_DEPLOY`) is still off.

- **Slice 1** — VM + network + Key Vault + Managed Identity + GitHub-OIDC deploy role (`infra/vm/terraform/`).
- **Slice 2 (this)** — the prod runtime topology: `compose.prod.yaml`, the Caddy single-origin router
  (`infra/vm/caddy/`), and the cloudflared tunnel.
- **Slice 3** — Key Vault → systemd credential files (replaces the secret placeholders below).
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

cloudflared uses a **token** tunnel (the token you store in Key Vault / `secrets/argus.prod.env`). Ingress
hostnames are configured in the Cloudflare Zero Trust dashboard, not in this repo:

- `4rgus.com` → `http://caddy:8080`  (the app — PWA + `/api` + `/ws`, all same-origin)
- admin subdomains (e.g. ops/identity) → their service, **gated by Cloudflare Access** (identity at the edge)

## Secrets (placeholder today → Key Vault in Slice 3)

No secret values live in the repo. `compose.prod.yaml` reads them from gitignored files:

- `secrets/postgres_password` — single line; Postgres reads it via `POSTGRES_PASSWORD_FILE`.
- `secrets/argus.prod.env` — `DATABASE_URL` (incl. password), `S3_SECRET_ACCESS_KEY`, `TUNNEL_TOKEN`.

Non-secret config (B2 endpoint/region/bucket + access-key-**id**, OIDC issuer/audience, image tags) is in
`.env.prod.example` — copy it into the deploy environment. In production, **Slice 3** generates these files
from Azure Key Vault via the VM's Managed Identity at deploy time (systemd credential files) and they are
never committed nor baked into an image (invariant #5).

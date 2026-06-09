# Production deploy (single Azure VM)

How the production stack runs on the single Azure VM (`germanywestcentral`). **Status: built, not yet
deployed.** The infrastructure exists as code across slices; CD (`vars.ENABLE_DEPLOY`) is still off.

- **Slice 1** — VM + network + Key Vault + Managed Identity + GitHub-OIDC deploy role (`infra/vm/terraform/`).
- **Slice 2** — the prod runtime topology: `compose.prod.yaml`, the Caddy single-origin router
  (`infra/vm/caddy/`), and the cloudflared tunnel.
- **Slice 3** — Key Vault → credential files: `argus-secrets.service` fetches secrets via the Managed
  Identity into `/run/argus/secrets/` (tmpfs) — `infra/vm/secrets/`.
- **Slice 4 (this)** — CD: `cd.yml` builds/scans/signs both images → GHCR, then `az vm run-command` rolls out
  (`infra/vm/deploy/deploy.sh`) with **migrate-before-serve**. Gated behind `vars.ENABLE_DEPLOY`.

## Topology

```
users ─HTTPS─▶ Cloudflare edge (TLS · WAF · rate-limit) ─tunnel─▶ cloudflared ─▶ caddy:8080
               caddy host-splits by domain:
                 4rgus.com      → PWA + reverse-proxies /api,/ws → api:3000
                 auth.4rgus.com → zitadel:8080 (OIDC/console, h2c) ; /ui/v2/login → zitadel-login:3000
               api ─▶ postgres / redis (internal Docker network, NO published ports)
               api ─▶ Backblaze B2 (egress, presigned)
               zitadel ─▶ zitadel-db (own Postgres, internal network, NO published port)
```

The VM opens **no inbound port** (NSG denies all inbound; `infra/vm/terraform/`). The only way in is the
**outbound** Cloudflare tunnel. TLS, WAF, and the edge rate-limit live at Cloudflare; Caddy speaks plain HTTP
on a non-privileged port over the internal Docker network only. Threat model:
`docs/threat-models/vm-ingress.md`.

## The stack (`compose.prod.yaml`)

Standalone prod stack — **not** layered over `compose.yaml` (that file is local-dev only). Services:
`postgres`, `redis`, `api`, `caddy` (PWA + router), `cloudflared`, and the self-hosted identity provider
`zitadel` + `zitadel-db` + `zitadel-login` (roadmap #9). No `minio` (prod uses Backblaze B2). No service
publishes a host port. Every service runs hardened (non-root where the image allows, `no-new-privileges`,
`cap_drop: [ALL]`, resource limits).

> **Zitadel** (roadmap #9) is the OIDC issuer at `https://auth.4rgus.com` — a **public** login surface (end
> users authenticate against it; it is NOT behind Cloudflare Access, which would be circular for end-user
> login). Its admin console is protected by Zitadel's own authentication. TLS terminates at Cloudflare;
> Zitadel runs `--tlsMode external` + `ExternalSecure=true` behind it. See the **Zitadel bootstrap** section
> below + `docs/threat-models/vm-zitadel.md`. Provisioning (project / SPA app / tenant-claim Action) + the
> multi-tenant org→`tenant_id` mapping are the deferred **G1** follow-on.

### Images

`api` and `caddy` are **pulled by tag**, not built on the VM — `cd.yml` builds, scans (Trivy), and signs
(cosign) them, and sets `ARGUS_API_IMAGE` / `ARGUS_INGRESS_IMAGE` to the registry digest (Slice 4). To build
the ingress image locally for verification:

```bash
docker build -f infra/vm/caddy/Dockerfile -t argus-ingress:local .   # context = repo root
docker compose -f compose.prod.yaml config -q                         # validate the stack
```

## Release & rollout (CD — `cd.yml`)

**Release on a version tag.** To cut a release you push a semver tag — the version *is* the image tag, so the
deployed artifact is always traceable to the git tag:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

That triggers `cd.yml`:

1. **Builds both images** (matrix: `api` + the Caddy `ingress` that bakes the PWA), tagged with the version →
   pushes to **GHCR** → **Trivy** scan (fail on HIGH/CRITICAL) → **syft** SBOM → **cosign** keyless sign +
   attest.
2. **Rolls out** — logs in to Azure via OIDC, bundles the exact-SHA infra config (compose + the secret-fetch
   unit + `deploy.sh`) into an `az vm run-command` invocation, so the **VM token stays pull-only** (it can't
   read the repo). The control plane runs `deploy.sh` as root on the VM (no SSH, no open port).

**Two-layer gate.** `vars.ENABLE_DEPLOY` is the master kill-switch (off until the Azure subscription +
secrets exist). The deploy job runs in the **`prod` GitHub Environment** — configure it with **required
reviewers (you)**, so every tagged release **pauses for your manual approval** before the root run-command
runs. The OIDC federated subject is bound to that environment (`var.github_deploy_subject`), not a branch.

`infra/vm/deploy/deploy.sh` on the VM: installs/refreshes `argus-secrets.service` → fetches the runtime
secret set (Managed Identity → `/run/argus/secrets`) → `docker login ghcr.io` (token from Key Vault) + pulls
the images → **`cosign verify`s** each (against this repo's `cd.yml` OIDC identity) and rolls out **by
digest** → brings up Postgres/Redis → runs **DB migrations as the owner** (file-mounted DSN, then `shred`-ed)
**before** the api serves → brings up `api` + `caddy` + `cloudflared`. Idempotent + fail-closed.
Threat model: [`docs/threat-models/vm-cd.md`](threat-models/vm-cd.md).

**Repo vars/secrets** (from the Terraform outputs): secrets `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/
`AZURE_SUBSCRIPTION_ID`; vars `AZURE_RESOURCE_GROUP`/`AZURE_VM_NAME`/`KEY_VAULT_NAME`; the api's non-secret
runtime config `S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`/`S3_ACCESS_KEY_ID` (the B2 key **id**) +
`OIDC_ISSUER`/`OIDC_AUDIENCE` (CD passes these into `compose up`); the PWA's build-time `VITE_OIDC_*`; and
`ENABLE_DEPLOY=true` to arm it. GHCR **push** uses the built-in `GITHUB_TOKEN`; the VM's GHCR **pull** uses
the `argus-ghcr-token` PAT from Key Vault — set `vars.GHCR_USER` to the account that owns that PAT if it isn't
the repo owner (the default).

## Cloudflare tunnel ingress (dashboard-managed)

cloudflared uses a **token** tunnel (the token stored in Key Vault as `argus-tunnel-token`). Ingress
hostnames are configured in the Cloudflare Zero Trust dashboard, not in this repo:

- `4rgus.com` → `http://caddy:8080`  (the app — PWA + `/api` + `/ws`, all same-origin)
- `auth.4rgus.com` → `http://caddy:8080`  (self-hosted Zitadel — Caddy host-splits this domain to
  `zitadel`/`zitadel-login`; **public**, NOT behind Access — it's the end-user login surface)
- other admin subdomains (e.g. ops) → their service, **gated by Cloudflare Access** (identity at the edge)

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
- `secrets/zitadel_masterkey` → `zitadel` reads it via `--masterkeyFile` (32-byte instance masterkey).
- `secrets/zitadel_db_password` → `zitadel-db` reads it via `POSTGRES_PASSWORD_FILE`; `zitadel` reads the
  **same value** as the runtime `${ZITADEL_DB_PASSWORD}` (Zitadel has no `_FILE` env form for it).

The runtime-value secrets (the same exception as above) — `TUNNEL_TOKEN` (cloudflared has no shell /
`--token-file`), and Zitadel's `ZITADEL_DB_PASSWORD` + the first-init-only `ZITADEL_ADMIN_PASSWORD` — are
injected from the delivered Key Vault files by `deploy.sh` on `up` (`environment:` interpolation), never an
on-disk env file. Invariant #5 permits a runtime-fetched value alongside a mounted file.

Set the actual values in Key Vault once (the `az keyvault secret set` commands + the full name→file→consumer
table are in [`infra/vm/secrets/README.md`](../infra/vm/secrets/README.md)). Non-secret config (B2
endpoint/region/bucket + access-key-**id**, the API's OIDC issuer/audience, the PWA's build-time
`VITE_OIDC_*`, image tags) is in `.env.prod.example` — copy it into the deploy environment. The `secrets/`
directory (local dev) is gitignored; nothing is committed or baked into an image.

## Zitadel bootstrap (self-hosted IdP — roadmap #9)

The `zitadel` + `zitadel-db` + `zitadel-login` services are in `compose.prod.yaml`, hardened, no published
ports, reachable at `https://auth.4rgus.com`. **Built as code; not armed** — these one-time steps run when you
arm the deploy. Threat model: `docs/threat-models/vm-zitadel.md`.

**1 — Generate the masterkey ONCE.** It is exactly **32 bytes** and encrypts the keys Zitadel stores in its
DB; **never rotate it casually** (loss makes the instance's encrypted data unrecoverable — rely on Key Vault
soft-delete + purge-protection, and back it up with the rest of the vault material):

```bash
az keyvault secret set --vault-name "$KV" --name argus-zitadel-masterkey      --value "$(openssl rand -base64 32 | head -c 32)"
az keyvault secret set --vault-name "$KV" --name argus-zitadel-db-password    --value '<zitadel-db-owner-pw>'
az keyvault secret set --vault-name "$KV" --name argus-zitadel-admin-password --value '<bootstrap-admin-pw>'   # change on first login
```

**2 — First init.** On the first `deploy.sh` run, `start-from-init` creates the instance: the org, the Login
V2 service user (its PAT is written to the `zitadel-bootstrap` volume so `zitadel-login` can authenticate),
a bootstrap human admin (`admin`, password = `argus-zitadel-admin-password`, **change-required**), and — via
the `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_*` + `ZITADEL_OIDC_DEFAULTLOGINURLV2` env (init-only) — **Login
V2 is wired at first boot**, so the console + auth use `https://auth.4rgus.com/ui/v2/login` immediately (no
chicken-and-egg where you can't log in to provision). The DB password + admin password are runtime values
`deploy.sh` reads from the delivered Key Vault files. On every later boot the instance already exists, so
FirstInstance is skipped (the admin password is ignored).

**3 — Cloudflare ingress.** Add `auth.4rgus.com` → `http://caddy:8080` in the Zero Trust dashboard (a
**public** hostname, NOT behind Access — it's the end-user login surface). Caddy host-splits it to
`zitadel`/`zitadel-login`.

**4 — Harden + provision (manual, post-arm).** Log in to the console at `https://auth.4rgus.com` (Login V2 is
already wired from step 2), **change the admin password + enable MFA** immediately, then create the project /
SPA OIDC app / tenant-claim Action. The local provisioner (`infra/local/zitadel/provision.sh`) is the
reference for those API calls; the **multi-tenant org→`tenant_id` mapping** (the local Action hardcodes a
single dev UUID) is the deferred **G1** work. Set the **project id** as `OIDC_AUDIENCE` (the API's token
audience — what Zitadel puts in the access-token `aud`, per the local provisioner's `OIDC_AUDIENCE=$PROJECT_ID`)
and the **SPA client id** as `VITE_OIDC_CLIENT_ID`, then re-cut the release so the PWA build embeds them.

> **Footprint.** Zitadel adds ~1.8 GB of memory limits (`zitadel` 768m + `zitadel-db` 768m + `zitadel-login`
> 256m) on top of the app stack (~4 GB) — size the VM for ~6 GB+ before arming.

# Production deploy (single Azure VM)

How the production stack runs on the single Azure VM (`germanywestcentral`). **Status: built, not yet
deployed.** The infrastructure exists as code across slices; CD (`vars.ENABLE_DEPLOY`) is still off.

- **Slice 1** — VM + network + Key Vault + Managed Identity + GitHub-OIDC deploy role (`infra/azure/terraform/`).
- **Slice 2** — the prod runtime topology: `compose.prod.yaml`, the Caddy single-origin router
  (`infra/stack/caddy/`), and the cloudflared tunnel.
- **Slice 3** — Key Vault → credential files: `argus-secrets.service` fetches secrets via the Managed
  Identity into `/run/argus/secrets/` (tmpfs) — `infra/stack/secrets/`.
- **Slice 4 (this)** — CD: `cd.yml` builds/scans/signs both images → GHCR, then `az vm run-command` rolls out
  (`infra/stack/deploy/deploy.sh`) with **migrate-before-serve**. Gated behind `vars.ENABLE_DEPLOY`.

## Topology

```
users ─HTTPS─▶ Cloudflare edge (TLS · WAF · rate-limit) ─tunnel─▶ cloudflared ─▶ caddy:8080
               caddy serves:
                 4rgus.com      → PWA + reverse-proxies /api,/ws → api:3000
               api ─▶ postgres / redis (internal Docker network, NO published ports)
               api ─▶ Backblaze B2 (egress, presigned)
```

The VM opens **no inbound port** (NSG denies all inbound; `infra/azure/terraform/`). The only way in is the
**outbound** Cloudflare tunnel. TLS, WAF, and the edge rate-limit live at Cloudflare; Caddy speaks plain HTTP
on a non-privileged port over the internal Docker network only. Threat model:
`docs/threat-models/vm-ingress.md`.

## The stack (`compose.prod.yaml`)

Standalone prod stack — **not** layered over `compose.yaml` (that file is local-dev only). Services:
`postgres`, `redis`, `api`, `caddy` (PWA + router), `cloudflared`, and the observability stack `prometheus`
+ `grafana` + `alertmanager` (roadmap #47). No `minio` (prod uses Backblaze B2). No service publishes a host
port. Every service runs hardened (non-root where the image allows, `no-new-privileges`, `cap_drop: [ALL]`,
resource limits).

Auth is **passkey-only** — the API mints and verifies its own EdDSA session tokens. Zitadel/OIDC was
decommissioned in Phase 6 (`docs/threat-models/phase-6-decommission.md`); there is no external IdP.

### Images

`api` and `caddy` are **pulled by tag**, not built on the VM — `cd.yml` builds, scans (Trivy), and signs
(cosign) them, and sets `ARGUS_API_IMAGE` / `ARGUS_INGRESS_IMAGE` to the registry digest (Slice 4). To build
the ingress image locally for verification:

```bash
docker build -f infra/stack/caddy/Dockerfile -t argus-ingress:local .   # context = repo root
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

`infra/stack/deploy/deploy.sh` on the VM: installs/refreshes `argus-secrets.service` → fetches the runtime
secret set (Managed Identity → `/run/argus/secrets`) → `docker login ghcr.io` (token from Key Vault) + pulls
the images → **`cosign verify`s** each (against this repo's `cd.yml` OIDC identity) and rolls out **by
digest** → brings up Postgres/Redis → runs **DB migrations as the owner** (file-mounted DSN, then `shred`-ed)
**before** the api serves → brings up `api` + `caddy` + `cloudflared`. Idempotent + fail-closed.
Threat model: [`docs/threat-models/vm-cd.md`](../threat-models/vm-cd.md).

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
- `grafana.4rgus.com` → `http://caddy:8080`  (observability dashboards — Caddy host-splits to `grafana:3000`,
  **gated by Cloudflare Access** + Grafana's own login; Prometheus + Alertmanager stay internal-only)
- other admin subdomains (e.g. ops) → their service, **gated by Cloudflare Access** (identity at the edge)

### Admin (breakglass) access — Cloudflare Access on `/admin` + the admin API

The breakglass admin login is **not** on the public landing page. It lives at `https://4rgus.com/admin`, and
the admin/breakglass API (`/api/auth/breakglass/*`, `/api/admin/*`) is reachable **only** through Cloudflare
Access. Two layers enforce this (see [`docs/threat-models/admin-access-gating.md`](../threat-models/admin-access-gating.md)):

1. **Edge (Caddy):** `infra/stack/caddy/Caddyfile` returns **404** for those paths unless the request carries
   the `Cf-Access-Jwt-Assertion` header that cloudflared injects after a request passes Access (and strips if a
   client supplies it). No Terraform/code change beyond the Caddyfile.
2. **App (defense in depth):** the API verifies that JWT's signature (`CfAccessGuard`) **when** the two
   non-secret env vars below are set; unset = no-op (dev / before the Access app exists).

**Create the Access application (Zero Trust dashboard — same place as grafana/glitchtip):**

1. Access → Applications → **Add an application** → **Self-hosted**.
2. **Application domain:** add `4rgus.com` with **path** `/admin`, and add the same app's additional paths
   `/api/auth/breakglass` and `/api/admin` (the page **and** the XHRs it makes must both be behind Access).
3. **Session duration:** short (e.g. **1 hour**) — breakglass is rare.
4. **Policy:** Action **Allow** → Include → **Emails** → the operator's email only (everyone else is implicitly
   denied); optionally require the IdP's MFA.
5. Copy the application's **Audience (AUD) tag** and set the API env (non-secret, like the RP ID):
   - `CF_ACCESS_TEAM_DOMAIN` = your team (e.g. `acme.cloudflareaccess.com`)
   - `CF_ACCESS_AUD` = the AUD tag

No new tunnel hostname is needed (`4rgus.com → caddy:8080` already exists), and **no secret** is introduced.
Recovery-of-last-resort if Access is unavailable stays the **direct-DB owner runbook** in
[`breakglass-admin.md`](../threat-models/breakglass-admin.md) — there is deliberately no "skip Access" bypass.

> **Load-bearing defaults / arming.** Keep the Access app's default behaviour of **stripping client-supplied
> `Cf-Access-*` headers** — the Caddy 404 gate trusts that cloudflared only ever forwards a header it injected.
> Until you set `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`, the API logs a one-line **WARN at boot**
> (`Cloudflare Access verification DISABLED …`) and the admin/breakglass API is protected by the **edge gate
> only** (sufficient for the single-VM topology, since nothing but cloudflared reaches Caddy). Setting both
> vars flips the boot log to `ENABLED` — grep the API logs after arming to confirm.

## Secrets (Key Vault → credential files — Slice 3)

No secret values live in the repo. `argus-secrets.service` fetches them from Azure Key Vault via the VM's
Managed Identity into `/run/argus/secrets/` (tmpfs, `0444` root files inside a `0700` root dir — `0444` so the
non-root container users can read the bind-mounted Compose secrets, since Docker does not remap the file owner
on Linux; the `0700` dir is the confinement boundary) at boot — see
[`infra/stack/secrets/`](../../infra/stack/secrets/README.md). The stack consumes them as **mounted credential files**
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
- `secrets/redis_password` → `deploy.sh` generates two credential **files** from it: `redis.conf`
  (`requirepass`, config-file AUTH — never a `--requirepass` argv) for the server, and `redis_url`
  (`redis://:<pw>@redis:6379`) which the api reads via `REDIS_URL_FILE`. The redis healthcheck reads this
  `redis_password` file directly for `REDISCLI_AUTH`. No Redis credential ever rides env / `docker inspect`.
  URL-safe (`openssl rand -hex 32`).
The cloudflared tunnel token is also a mounted credential **file** (`tunnel_token`); cloudflared reads it via
`TUNNEL_TOKEN_FILE` (>=2025.4.0), so no token enters the `compose up` env or container config. Invariant #5
permits a runtime-fetched value alongside a mounted file.

Set the actual values in Key Vault once (the `az keyvault secret set` commands + the full name→file→consumer
table are in [`infra/stack/secrets/README.md`](../../infra/stack/secrets/README.md)). Non-secret config (B2
endpoint/region/bucket + access-key-**id**, the API's OIDC issuer/audience, the PWA's build-time
`VITE_OIDC_*`, image tags) is in `.env.prod.example` — copy it into the deploy environment. The `secrets/`
directory (local dev) is gitignored; nothing is committed or baked into an image.

## Observability (Prometheus + Grafana + Alertmanager — roadmap #47)

The API exposes content-blind Prometheus metrics on an internal `:9090` (Slice A, merged). Slice B adds the
stack: **Prometheus** scrapes `api:9090` over the internal network, **Grafana** visualises it, **Alertmanager**
routes alerts. Config lives in `infra/stack/observability/` (`deploy.sh` stages it to `/opt/argus`; the services
bind-mount it read-only). Threat model: `docs/threat-models/observability.md`. **Built as code; armed with the
rest of the deploy.**

- **Exposure:** only **Grafana** has ingress — `grafana.4rgus.com` via Caddy, **behind Cloudflare Access** +
  Grafana's own login. Prometheus + Alertmanager have no published ports and aren't routed; view them through
  Grafana (or a one-off port-forward during ops). `/metrics` stays internal (Slice A).
- **Secret:** Grafana's admin password is a Key-Vault credential file (`argus-grafana-admin-password` →
  `GF_SECURITY_ADMIN_PASSWORD__FILE`). Set it in Key Vault before the first deploy.
- **SLOs** (in `prometheus/rules/argus-api.yml`, tune against real traffic): availability (scrape target up),
  5xx ratio < 1% (warn) / 5% (page), p95 latency < 1s.
- **Alert delivery:** Alertmanager ships with a **null receiver** (alerts visible in its UI). Add a real
  receiver — webhook/email/Slack, its secret from Key Vault, content-free — when you want notifications.
- **Arming:** add the `grafana.4rgus.com` Cloudflare Access app + tunnel hostname; set the Grafana admin
  password in Key Vault; pin/refresh the `prom/*` + `grafana/grafana` + `grafana/loki` + `grafana/alloy` image
  tags. Smoke-test the read-only FS on the images in a scratch env (prod is the first place they run
  read-only-root).

### Centralized logs (Loki + Alloy — roadmap #47b)

Added to the stack (built; deploys at arming): **Loki** (log store — filesystem, 7-day retention, no auth,
**internal only / no published port**) and **Alloy** (collector). Logs are queried in the **same Grafana** via
a provisioned **Loki** datasource. App logs are **IDs/metadata only** by discipline (Semgrep-gated); Alloy adds
a scrub stage masking bearer/JWT/presigned-URL shapes as defense-in-depth. Threat model:
`docs/threat-models/centralized-logs.md`.

- **No Docker socket.** Alloy file-tails `/var/lib/docker/containers` mounted **read-only** — a socket mount is
  daemon-root-equivalent and is deliberately avoided. Alloy runs as **uid 0** (the only way to read the
  `root:root 0640` json logs) but with `cap_drop:[ALL]` + read-only rootfs + the read-only log mount, so it can
  read logs and nothing more.
- **Exposure:** none — neither Loki nor Alloy publishes a port (the compose-guard CI check enforces it); they
  are reachable only on the internal Docker network. Grafana stays the only ingress.
- **Arming:** verify/refresh the `grafana/loki` + `grafana/alloy` image tags; logs flow automatically once the
  stack is up (no DSN/secret to set). Loki data is transient observability — **not** covered by the nightly B2
  backup.

## Error tracking (Sentry/GlitchTip — roadmap #48)

The API integrates the `@sentry/node` SDK (Slice A, merged), **DSN-GATED**: with `SENTRY_DSN` unset — the
default — it is a complete **no-op** (nothing initialised, nothing sent). Events are **default-deny scrubbed**
before send: no message content, MLS/session/device keys, tokens, full `Authorization` headers, cookies,
request bodies/query, or presigned URLs ever leave; an event carries only error type/message/stack, the HTTP
method + route-**template**, the release, and opaque tenant/user id tags (invariant #2). Threat model:
`docs/threat-models/error-tracking.md`. Only genuine server faults are captured (5xx + unhandled; 4xx is
skipped), via a non-invasive interceptor that observes + rethrows — the response shape is unchanged.

- **Backend:** self-hosted **GlitchTip** (Sentry-API-compatible) as a gated Compose service is **Slice B** (not
  yet in the tree); SaaS Sentry EU is a one-line DSN swap (same SDK + protocol, zero lock-in).
- **Arming:** stand up GlitchTip (or point at Sentry EU), create a project, then set **`SENTRY_DSN`** in the
  deploy env — it is already wired into the `api` container (Slice A), so nothing else is needed (it is a
  write-only **ingest** key, not a read credential, so env is fine; `SENTRY_RELEASE` defaults to `IMAGE_TAG`).
  The mounted-file form (`SENTRY_DSN_FILE` → an `argus-sentry-dsn` Key Vault secret) lands with the GlitchTip
  service in Slice B. Nothing emits until the DSN is set.

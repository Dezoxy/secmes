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
               caddy host-splits by domain:
                 4rgus.com      → PWA + reverse-proxies /api,/ws → api:3000
                 auth.4rgus.com → zitadel:8080 (OIDC/console, h2c) ; /ui/v2/login → zitadel-login:3000
               api ─▶ postgres / redis (internal Docker network, NO published ports)
               api ─▶ Backblaze B2 (egress, presigned)
               zitadel ─▶ zitadel-db (own Postgres, internal network, NO published port)
```

The VM opens **no inbound port** (NSG denies all inbound; `infra/azure/terraform/`). The only way in is the
**outbound** Cloudflare tunnel. TLS, WAF, and the edge rate-limit live at Cloudflare; Caddy speaks plain HTTP
on a non-privileged port over the internal Docker network only. Threat model:
`docs/threat-models/vm-ingress.md`.

## The stack (`compose.prod.yaml`)

Standalone prod stack — **not** layered over `compose.yaml` (that file is local-dev only). Services:
`postgres`, `redis`, `api`, `caddy` (PWA + router), `cloudflared`, the self-hosted identity provider
`zitadel` + `zitadel-db` + `zitadel-login` (roadmap #9), and the observability stack `prometheus` + `grafana`
+ `alertmanager` (roadmap #47). No `minio` (prod uses Backblaze B2). No service publishes a host port. Every
service runs hardened (non-root where the image allows, `no-new-privileges`, `cap_drop: [ALL]`, resource
limits).

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
- `grafana.4rgus.com` → `http://caddy:8080`  (observability dashboards — Caddy host-splits to `grafana:3000`,
  **gated by Cloudflare Access** + Grafana's own login; Prometheus + Alertmanager stay internal-only)
- other admin subdomains (e.g. ops) → their service, **gated by Cloudflare Access** (identity at the edge)

### Admin (breakglass) access — Cloudflare Access on `/admin` + the admin API

The breakglass admin login is **not** on the public landing page. It lives at `https://4rgus.com/admin`, and
the admin/breakglass API (`/api/auth/breakglass/*`, `/api/admin/*`) is reachable **only** through Cloudflare
Access. Two layers enforce this (see [`docs/threat-models/admin-access-gating.md`](threat-models/admin-access-gating.md)):

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
[`breakglass-admin.md`](threat-models/breakglass-admin.md) — there is deliberately no "skip Access" bypass.

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
[`infra/stack/secrets/`](../infra/stack/secrets/README.md). The stack consumes them as **mounted credential files**
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
- `secrets/zitadel_masterkey` → `zitadel` reads it via `--masterkeyFile` (32-byte instance masterkey).
- `secrets/zitadel_db_password` → `zitadel-db` reads it via `POSTGRES_PASSWORD_FILE`; `zitadel` reads the
  **same value** as the runtime `${ZITADEL_DB_PASSWORD}` (Zitadel has no `_FILE` env form for it).

The runtime-value secrets (the same exception as above) — `TUNNEL_TOKEN` (cloudflared has no shell /
`--token-file`), and Zitadel's `ZITADEL_DB_PASSWORD` + the first-init-only `ZITADEL_ADMIN_PASSWORD` — are
injected from the delivered Key Vault files by `deploy.sh` on `up` (`environment:` interpolation), never an
on-disk env file. Invariant #5 permits a runtime-fetched value alongside a mounted file.

Set the actual values in Key Vault once (the `az keyvault secret set` commands + the full name→file→consumer
table are in [`infra/stack/secrets/README.md`](../infra/stack/secrets/README.md)). Non-secret config (B2
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
V2 service-user machine account, a bootstrap human admin (`admin`, password = `argus-zitadel-admin-password`,
**change-required**), and — via the `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_*` + `ZITADEL_OIDC_DEFAULTLOGINURLV2`
env (init-only) — **Login V2 is wired at first boot** (the instance's login URLs point at `/ui/v2/login`). The
DB password + admin password are runtime values `deploy.sh` reads from the delivered Key Vault files. On every
later boot the instance already exists, so FirstInstance is skipped (the admin password is ignored).

**3 — Cloudflare ingress.** Add `auth.4rgus.com` → `http://caddy:8080` in the Zero Trust dashboard (a
**public** hostname, NOT behind Access — it's the end-user login surface). Caddy host-splits it to
`zitadel`/`zitadel-login`.

**4 — Seed the Login V2 PAT into Key Vault.** The login container authenticates to the Zitadel API with a
service-user PAT that — per invariant #2 — is **not** persisted to a Docker volume; it's a Key-Vault-delivered
credential file, empty until you provision it (so the login UI is degraded until this step). FirstInstance
writes its first PAT to the zitadel container's tmpfs; grab it and store it in Key Vault, then re-deliver:

```bash
COMPOSE=/opt/argus/compose.prod.yaml
# Copy the PAT out host-side with `docker cp` (daemon-side — needs no shell/cat in the minimal zitadel image,
# which has neither; `tar -xO` streams the one file to stdout so the token never lands on host disk).
zid="$(docker compose -f "$COMPOSE" ps -q zitadel)"
PAT="$(docker cp "$zid:/tmp/login-client.pat" - | tar -xO)"
az keyvault secret set --vault-name "$KV" --name argus-zitadel-login-pat --value "$PAT"
sudo systemctl restart argus-secrets.service                 # re-fetch → /run/argus/secrets/zitadel_login_pat
# --force-recreate: a plain `up -d` won't recreate an unchanged service, so it would keep the OLD (empty)
# secret file mounted; force a recreate so the now-populated PAT is re-mounted. ARGUS_SECRETS_DIR points
# compose's secret source at the tmpfs the fetch wrote to (matches what deploy.sh exports).
ARGUS_SECRETS_DIR=/run/argus/secrets \
  docker compose -f "$COMPOSE" up -d --force-recreate --no-deps zitadel-login
```

From here on `argus-secrets.service` re-delivers it on every boot (reboot-safe). If `/tmp/login-client.pat` is
already gone (container restarted), mint a fresh PAT for the `login-client` machine user in the console
instead.

**5 — Harden + provision (manual, post-arm).** Log in to the console at `https://auth.4rgus.com`, **change the
admin password + enable MFA** immediately, then create the project / SPA OIDC app / tenant-claim Action. The
local provisioner (`infra/local/zitadel/provision.sh`) is the reference for those API calls; the **multi-tenant
org→`tenant_id` mapping** (the local Action hardcodes a single dev UUID) is the deferred **G1** work. Set the
**project id** as `OIDC_AUDIENCE` (the API's token audience — what Zitadel puts in the access-token `aud`, per
the local provisioner's `OIDC_AUDIENCE=$PROJECT_ID`) and the **SPA client id** as `VITE_OIDC_CLIENT_ID`, then
re-cut the release so the PWA build embeds them.

> **Footprint.** Zitadel adds ~1.8 GB of memory limits (`zitadel` 768m + `zitadel-db` 768m + `zitadel-login`
> 256m) on top of the app stack (~4 GB); the observability stack (below) adds ~1.4 GB (`prometheus` 768m +
> `grafana` 512m + `alertmanager` 128m) — size the VM for **~8 GB+** before arming.

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

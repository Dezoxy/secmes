#!/usr/bin/env bash
# argus — VM rollout, executed as root ON THE VM by `az vm run-command` (no SSH, no open port). cd.yml bundles
# the exact-SHA repo infra files, ships them through the Azure control plane, unpacks them, and runs this from
# the unpacked tree. Idempotent + fail-closed. See docs/deploy.md + docs/threat-models/vm-cd.md.
#
# Sequence: install/refresh the secret-fetch unit → fetch secrets (Managed Identity → /run/argus/secrets) →
# log in to GHCR + pull the signed images → bring up data services → run DB MIGRATIONS as the owner BEFORE
# the api serves → bring up api + caddy + cloudflared.
#
# Required env (exported by the cd.yml run-command wrapper; all NON-secret):
#   ARGUS_KEY_VAULT  Key Vault name (the token comes from the VM Managed Identity via IMDS — no static creds)
#   IMAGE_TAG        image tag to roll out (the deployed commit SHA)
#   GHCR_REGISTRY    registry namespace, e.g. ghcr.io/dezoxy
#   GHCR_USER        GitHub username/owner for `docker login ghcr.io` (the token is fetched from Key Vault)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${ARGUS_KEY_VAULT:?ARGUS_KEY_VAULT required}"
: "${IMAGE_TAG:?IMAGE_TAG required}"
: "${GHCR_REGISTRY:?GHCR_REGISTRY required (e.g. ghcr.io/owner)}"
: "${GHCR_USER:?GHCR_USER required}"
: "${GH_REPO:?GH_REPO required (owner/repo, for the cosign signing identity)}"

APP_DIR=/opt/argus
SECRETS_DIR=/run/argus/secrets
COMPOSE="$APP_DIR/compose.prod.yaml"
GHCR_HOST="${GHCR_REGISTRY%%/*}"
API_IMAGE="$GHCR_REGISTRY/argus-api:$IMAGE_TAG"
INGRESS_IMAGE="$GHCR_REGISTRY/argus-ingress:$IMAGE_TAG"
KV_API_VERSION="7.4"

log() { printf 'argus-deploy: %s\n' "$*"; } # names/status only — never a secret value

# --- Managed-Identity helpers: fetch the two deploy-TRANSIENT secrets (GHCR pull token + owner migration DSN)
#     straight from Key Vault. They are NOT part of the persistent /run/argus/secrets set the running stack
#     uses (least privilege: the stack never holds the owner DSN or a GitHub token). ---
mi_token() {
  curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 -H 'Metadata: true' \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net" |
    jq -r '.access_token // empty'
}
kv_get() { # $1 = secret name ; $2 = MI bearer token (passed via curl --config stdin, never argv/cmdline)
  curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 --config - \
    "https://${ARGUS_KEY_VAULT}.vault.azure.net/secrets/${1}?api-version=${KV_API_VERSION}" <<EOF | jq -r '.value // empty'
header = "Authorization: Bearer ${2}"
EOF
}

# --- 1. Stage config + the secret-fetch unit (idempotent). ---
log "staging config into ${APP_DIR}"
install -d -m 0750 -o root -g argus "$APP_DIR" "$APP_DIR/secrets"
install -m 0640 -o root -g argus "$REPO_ROOT/compose.prod.yaml" "$COMPOSE"
# Observability config tree (Prometheus/Grafana/Alertmanager) — the compose services bind-mount it read-only
# at ./infra/vm/observability (relative to $COMPOSE in $APP_DIR). World-readable (0755 dirs / 0644 files) so
# the non-root prometheus/grafana container users can read it; it contains NO secrets (Grafana's admin pw is a
# Key Vault credential file, not in this tree). Refresh from the staged repo each deploy.
rm -rf "$APP_DIR/infra/vm/observability" "$APP_DIR/infra/vm/glitchtip"
install -d -m 0755 "$APP_DIR/infra/vm"
cp -a "$REPO_ROOT/infra/vm/observability" "$APP_DIR/infra/vm/observability"
chmod -R a+rX "$APP_DIR/infra/vm/observability"
# GlitchTip entrypoint wrapper — bind-mounted read-only into the glitchtip + glitchtip-worker containers.
# Contains NO secrets (reads them from Docker-secret files at runtime); world-executable so the container
# user can exec it regardless of uid.
install -d -m 0755 "$APP_DIR/infra/vm/glitchtip"
install -m 0755 "$REPO_ROOT/infra/vm/glitchtip/docker-entrypoint.sh" "$APP_DIR/infra/vm/glitchtip/docker-entrypoint.sh"
chmod a+rx "$APP_DIR/infra/vm/glitchtip/docker-entrypoint.sh"
install -m 0755 "$REPO_ROOT/infra/vm/secrets/fetch-keyvault-secrets.sh" "$APP_DIR/secrets/fetch-keyvault-secrets.sh"
install -m 0644 "$REPO_ROOT/infra/vm/secrets/argus-secrets.service" /etc/systemd/system/argus-secrets.service
# Point the unit at our fetch script + the real vault name (the repo ships a placeholder).
sed -i "s|/opt/argus/secrets/fetch-keyvault-secrets.sh|$APP_DIR/secrets/fetch-keyvault-secrets.sh|" \
  /etc/systemd/system/argus-secrets.service
sed -i "s/REPLACE_WITH_KEY_VAULT_NAME/${ARGUS_KEY_VAULT}/" /etc/systemd/system/argus-secrets.service
systemctl daemon-reload

# --- 2. Fetch the persistent runtime secret set (fail closed: a failure here aborts the deploy). ---
log "fetching runtime secrets via Managed Identity"
systemctl restart argus-secrets.service
systemctl enable argus-secrets.service >/dev/null 2>&1 || true

# --- 3. GHCR login (token from Key Vault, transient) + pull the signed images. ---
log "pulling images ${IMAGE_TAG} from ${GHCR_REGISTRY}"
_tok="$(mi_token)"
[ -n "$_tok" ] || {
  log "FATAL: no Managed Identity token"
  exit 1
}
kv_get argus-ghcr-token "$_tok" | docker login "$GHCR_HOST" -u "$GHCR_USER" --password-stdin
# Drop the GHCR credentials on ANY exit (incl. a mid-rollout failure) so the token isn't left in the VM's
# docker config after a failed deploy.
trap 'docker logout "$GHCR_HOST" >/dev/null 2>&1 || true' EXIT
docker pull "$API_IMAGE" >/dev/null
docker pull "$INGRESS_IMAGE" >/dev/null

# VERIFY the keyless cosign signature before running anything: resolve each tag to its immutable digest and
# check it was signed by THIS repo's cd.yml run for THIS EXACT release tag (IMAGE_TAG) via GitHub OIDC. Exact
# identity (not a `refs/tags/` prefix) so a tag overwritten to a different-but-legitimately-signed older digest
# (a downgrade/rollback) fails. A bad/missing/wrong-tag signature exits non-zero (set -e) → the tampered image
# never runs. Rolling out by DIGEST also closes the tag-swap TOCTOU window.
log "verifying image signatures (cosign)"
api_digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$API_IMAGE")"
ingress_digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$INGRESS_IMAGE")"
cosign_id="https://github.com/${GH_REPO}/.github/workflows/cd.yml@refs/tags/${IMAGE_TAG}"
cosign verify --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --certificate-identity "$cosign_id" "$api_digest" >/dev/null
cosign verify --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --certificate-identity "$cosign_id" "$ingress_digest" >/dev/null

export ARGUS_API_IMAGE="$api_digest"
export ARGUS_INGRESS_IMAGE="$ingress_digest"
export ARGUS_SECRETS_DIR="$SECRETS_DIR"

# --- 3b. Redis AUTH prep — MUST run before step 4 starts redis. From the Key Vault redis_password, generate
#        two credential FILES (never env — invariant #5: a password in container env surfaces via `docker
#        inspect` / the daemon's at-rest config):
#          • redis.conf  → redis-server `requirepass` (config-file AUTH, never a `--requirepass` argv leak)
#          • redis_url   → the api's REDIS_URL_FILE (ioredis parses `redis://:<pw>@redis:6379`)
#        Both are 0444 tmpfs Docker-secret files (0444 not 0400 — file-secrets are bind-mounted root-owned and
#        must be readable by the non-root container users; see the chmod note below). The raw redis_password
#        file (already fetched) is mounted into redis so its healthcheck reads REDISCLI_AUTH from a file too.
#        So NO Redis credential ever lands in env.
#        These must exist before the first `up -d ... redis` — generating them in step 6 (after redis already
#        started) fails the first deploy because the `redis_conf` secret source would be absent. ---
[ -s "$SECRETS_DIR/redis_password" ] || {
  log "FATAL: missing/empty runtime secret file: redis_password"
  exit 1
}
_redispw="$(cat "$SECRETS_DIR/redis_password")"
# Enforce the documented contract: the password rides UNQUOTED in redis.conf's `requirepass` and in redis_url's
# userinfo, so a value with a space / `#` / `@` / `:` / `"` would be silently truncated or mis-parsed. Reject
# anything outside the URL-unreserved set (a comment isn't enforcement) — `openssl rand -hex 32` satisfies it.
# Loud FATAL beats a half-set password or a wrong-password api at runtime.
case "$_redispw" in
*[!A-Za-z0-9._~-]*)
  log "FATAL: argus-redis-password must be URL-safe (A-Za-z0-9._~- only — e.g. openssl rand -hex 32)"
  exit 1
  ;;
esac
_redis_conf="$(printf 'save ""\nappendonly no\nrequirepass %s' "$_redispw")"
# Detect whether the redis password/conf CHANGED since the last deploy so step 4 can force-recreate redis only
# when it must (see there). `up -d` recreates a container on a config/image change but NOT when a mounted
# secret FILE's *content* changes — so a rotated redis password wouldn't reach the running redis without this.
REDIS_CONF_CHANGED=1
if [ -f "$SECRETS_DIR/redis.conf" ] && [ "$_redis_conf" = "$(cat "$SECRETS_DIR/redis.conf")" ]; then
  REDIS_CONF_CHANGED=0
fi
printf '%s\n' "$_redis_conf" >"$SECRETS_DIR/redis.conf"
printf 'redis://:%s@redis:6379' "$_redispw" >"$SECRETS_DIR/redis_url"
# Mode 0444, NOT 0400: file-based Compose secrets are bind-mounted, and the host file's owner/mode carry
# through to the container UNCHANGED on Linux (no uid/gid remapping — that only happens on macOS Docker
# Desktop's file-sharing layer, which is why a Mac test misleadingly "passes"). These files are root-owned,
# so a 0400 file is unreadable by the non-root consumers (redis uid 999, api/node uid 1000) and the rollout
# fails. 0444 lets the container user read them; confinement is the 0700 root tmpfs SECRETS_DIR, not the mode.
chmod 0444 "$SECRETS_DIR/redis.conf" "$SECRETS_DIR/redis_url"
_redispw=""
_redis_conf=""

# --- 3c. GlitchTip DATABASE_URL — derived from glitchtip_db_password (same pattern as redis_url above).
#         The URL is NEVER stored in Key Vault directly; only the password is. This keeps the single source
#         of truth in Key Vault and lets us change the service hostname without a KV rotation. ---
[ -s "$SECRETS_DIR/glitchtip_db_password" ] || {
  log "FATAL: missing/empty runtime secret file: glitchtip_db_password"
  exit 1
}
_gtpw="$(cat "$SECRETS_DIR/glitchtip_db_password")"
# Enforce URL-safe characters: the password is embedded raw into the postgresql:// DSN. Special chars
# (@, :, /, #, ?, etc.) split the userinfo / host / path segments and produce a silently wrong DSN that
# dj-database-url misparses. Reject anything outside the URL-unreserved set — same rule as redis_password.
case "$_gtpw" in
*[!A-Za-z0-9._~-]*)
  log "FATAL: argus-glitchtip-db-password must be URL-safe (A-Za-z0-9._~- only — e.g. openssl rand -hex 32)"
  exit 1
  ;;
esac
printf 'postgresql://glitchtip:%s@glitchtip-db:5432/glitchtip' "$_gtpw" >"$SECRETS_DIR/glitchtip_database_url"
chmod 0444 "$SECRETS_DIR/glitchtip_database_url"
_gtpw=""

# --- 4. Bring up data services first; wait for Postgres to be healthy before migrating. (redis comes up
#        authenticated — its redis.conf + redis_url credential files were generated in step 3b above; the
#        password is never passed via env.) ---
log "starting data services"
docker compose -f "$COMPOSE" up -d postgres
# Redis loads `requirepass` from redis.conf ONCE at startup. On a password ROTATION the conf file changed but
# `up -d` won't recreate the already-running redis (only a config/image change triggers that, not a mounted
# secret's new content), so it would keep the OLD password while the new-image api reads the NEW redis_url →
# auth fails. Force-recreate redis when its conf changed (step 3b — also true on a first deploy, where it just
# creates the container); a routine unchanged deploy leaves the running redis alone so the realtime backplane
# isn't needlessly bounced. Postgres is never force-recreated here (durable state).
if [ "${REDIS_CONF_CHANGED:-1}" = 1 ]; then
  log "redis conf is new/changed — (re)creating redis to load the current password"
  docker compose -f "$COMPOSE" up -d --force-recreate --no-deps redis
else
  docker compose -f "$COMPOSE" up -d --no-deps redis
fi
# GlitchTip gets its own dedicated Postgres cluster — start it alongside the app DB (both are cold-start
# idempotent). glitchtip-db is smaller (512m) and independent of the app schema / migrations.
docker compose -f "$COMPOSE" up -d --no-deps glitchtip-db
pg_cid="$(docker compose -f "$COMPOSE" ps -q postgres)"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_cid" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_cid" 2>/dev/null)" = "healthy" ] || {
  log "FATAL: Postgres did not become healthy"
  exit 1
}
# Wait for glitchtip-db separately (independent health; don't block the app-DB wait path).
gt_cid="$(docker compose -f "$COMPOSE" ps -q glitchtip-db)"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$gt_cid" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$gt_cid" 2>/dev/null)" = "healthy" ] || {
  log "FATAL: glitchtip-db did not become healthy"
  exit 1
}

# --- 4b. Stop the OLD api before migrating. On a redeploy the previous api container keeps running while the
#         owner migration mutates the schema below — a non-backward-compatible migration would have old code
#         hitting the new schema mid-deploy. Stopping it first closes that window. Brief /api downtime is the
#         in-place trade-off (caddy keeps serving the PWA; expand/contract migrations are the zero-downtime
#         future). No-op on the first deploy. ---
log "stopping the old api before migrating"
docker compose -f "$COMPOSE" stop api 2>/dev/null || true

# --- 5. MIGRATE BEFORE SERVING — as the OWNER, via a file-mounted DSN (never env). Runs to completion (and
#        the advisory lock serialises concurrent deploys) before the new api container takes traffic. ---
log "running DB migrations (owner) before serving"
# Stage the owner DSN on the same tmpfs argus-secrets.service guarantees exists (0750 root:argus).
_migfile="$(mktemp "$SECRETS_DIR/.migdsn.XXXXXX")"
chmod 0400 "$_migfile"
kv_get argus-migration-database-url "$_tok" >"$_migfile"
_tok="" # drop the KV bearer token from the shell as soon as the fetch is done (incl. the failure path below)
[ -s "$_migfile" ] || {
  log "FATAL: empty migration DSN"
  rm -f "$_migfile"
  exit 1
}
# Run the one-off migrate container as root (--user 0): deploy.sh runs as root, so the mounted DSN is
# root:root 0400 and the api image's default USER (node, uid 1000) couldn't read it. The migrate process only
# reads the DSN + talks to Postgres (no app runtime); the container stays read-only + cap_drop:ALL.
if ! docker compose -f "$COMPOSE" run --rm --no-deps --user 0 \
  -v "$_migfile":/run/migdsn:ro -e MIGRATION_DATABASE_URL_FILE=/run/migdsn \
  api node dist/db/migrate.js; then
  shred -u "$_migfile" 2>/dev/null || rm -f "$_migfile" # best-effort on tmpfs; the rm is the real cleanup
  log "FATAL: migrations failed — NOT serving the new image"
  exit 1
fi
shred -u "$_migfile" 2>/dev/null || rm -f "$_migfile" # best-effort on tmpfs; the rm is the real cleanup

# --- 6. Bring up the full stack. cloudflared's TUNNEL_TOKEN + Zitadel's DB/admin passwords are RUNTIME values
#        read from the delivered Key Vault files (the accepted env exception — never a committed/on-disk env
#        file; see vm-zitadel.md §4). ZITADEL_DB_PASSWORD also backs zitadel-db's POSTGRES_PASSWORD_FILE (same
#        file, two consumers). ZITADEL_ADMIN_PASSWORD is read by FirstInstance on the FIRST init only — ignored
#        on every later boot (the instance already exists). ---
log "starting api + caddy + cloudflared + zitadel"
# Guard: these runtime-value files must exist + be non-empty before we `cat` them into the `up` env — else
# `set -e` aborts on a bare `cat: No such file` instead of a legible FATAL. fetch-keyvault-secrets.sh (same
# bundled SHA) already fails closed first, so this is belt-and-suspenders for a stale/partial secret set.
for _f in tunnel_token zitadel_db_password zitadel_admin_password; do
  [ -s "$SECRETS_DIR/$_f" ] || {
    log "FATAL: missing/empty runtime secret file: $_f"
    exit 1
  }
done
# Redis AUTH credential files (redis.conf + redis_url) were generated in step 3b and redis is already up and
# authenticated; this `up -d` only adds the remaining services. No Redis credential rides env — it's all files.
TUNNEL_TOKEN="$(cat "$SECRETS_DIR/tunnel_token")" \
  ZITADEL_DB_PASSWORD="$(cat "$SECRETS_DIR/zitadel_db_password")" \
  ZITADEL_ADMIN_PASSWORD="$(cat "$SECRETS_DIR/zitadel_admin_password")" \
  docker compose -f "$COMPOSE" up -d
# The api reads REDIS_URL_FILE ONCE at module construction and holds a persistent ioredis connection. On a
# redis password ROTATION the `up -d` above won't recreate the api when the image/config is unchanged (a
# same-IMAGE_TAG/secret-only redeploy) — it would keep authenticating with the OLD password against the
# now-rotated redis and break the realtime backplane. So when the conf changed (step 3b), force-recreate the
# api too — symmetric with the redis recreate in step 4. A normal new-image deploy already recreates it (and
# REDIS_CONF_CHANGED is 0 when the password didn't change), so this only fires on an actual rotation.
if [ "${REDIS_CONF_CHANGED:-1}" = 1 ]; then
  log "redis conf is new/changed — force-recreating api so it reconnects with the current password"
  docker compose -f "$COMPOSE" up -d --force-recreate --no-deps api
fi

# --- 6b. Gate on the new app containers becoming HEALTHY — `up -d` returns before they're ready, so without
#         this a crash-looping rollout would report success. A timeout/unhealthy fails the deploy (set -e),
#         so the run-command surfaces it instead of silently leaving the old/broken stack. ---
wait_healthy() { # $1 = compose service ; $2 = optional max attempts @ 2s each (default 60 = 120s)
  local cid attempts="${2:-60}"
  cid="$(docker compose -f "$COMPOSE" ps -q "$1")"
  [ -n "$cid" ] || {
    log "FATAL: $1 container not found after rollout"
    return 1
  }
  for _ in $(seq 1 "$attempts"); do
    case "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" in
    healthy) return 0 ;;
    unhealthy)
      log "FATAL: $1 became unhealthy"
      return 1
      ;;
    esac
    sleep 2
  done
  log "FATAL: $1 did not become healthy within the rollout window"
  return 1
}
# cloudflared has no healthcheck (it's the outbound tunnel = the only ingress); require it's up and NOT
# crash-looping (RestartCount stable across a short window), else the app is unreachable.
wait_running() { # $1 = compose service without a healthcheck
  local cid r1 r2
  cid="$(docker compose -f "$COMPOSE" ps -q "$1")"
  [ -n "$cid" ] || {
    log "FATAL: $1 container not found after rollout"
    return 1
  }
  sleep 8
  [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ] || {
    log "FATAL: $1 is not running"
    return 1
  }
  r1="$(docker inspect -f '{{.RestartCount}}' "$cid")"
  sleep 6
  r2="$(docker inspect -f '{{.RestartCount}}' "$cid")"
  [ "$r1" = "$r2" ] || {
    log "FATAL: $1 is restart-looping"
    return 1
  }
}
log "waiting for the rollout to become healthy (api, caddy, zitadel-db, zitadel, zitadel-login, glitchtip) + the tunnel"
wait_healthy api
wait_healthy caddy
wait_running cloudflared
# Zitadel exposes a real readiness probe (`zitadel ready`), so gate the DB + the API server on HEALTHY — not
# just "didn't crash". zitadel gets a longer window (150×2s=300s) for the cold first-init schema migration +
# FirstInstance seed; a bad masterkey/DB password or a stuck init fails the deploy loudly here.
wait_healthy zitadel-db
wait_healthy zitadel 150
# zitadel-login readiness depends on its Key-Vault-delivered service PAT. Gate CONDITIONALLY: while the PAT
# file is still empty (first boot, before arming-time provisioning) require only running+not-crash-looping so
# the first deploy can succeed; ONCE the PAT is provisioned (file non-empty) require HEALTHY, so a
# malformed/expired PAT or a broken Login V2 image is caught during the rollout instead of reported healthy.
if [ -s "$SECRETS_DIR/zitadel_login_pat" ]; then
  wait_healthy zitadel-login
else
  log "zitadel-login: service PAT not yet provisioned (empty) — gating on running only; seed it per docs/deploy.md"
  wait_running zitadel-login
fi
# Observability (checkpoint 47): the Prometheus/Grafana/Alertmanager images have no shell for a CMD
# healthcheck, so gate on running + not-crash-looping — catches a bad config mount / image without depending
# on an in-container probe. (Their own /-/healthy + /api/health endpoints are visible once up.)
wait_running prometheus
wait_running alertmanager
wait_running grafana
# Centralized logs (checkpoint 47b): same posture — Loki + Alloy have no shell for a CMD healthcheck, so gate
# on running + not-crash-looping (catches a bad config mount / missing log dir / image pull).
wait_running loki
wait_running alloy
# Error tracking (checkpoint 48): glitchtip has a healthcheck (wget /api/0/version/) that
# only passes after migrations complete + gunicorn is serving — gate on HEALTHY to catch a
# bad SECRET_KEY, migration failure, or DB connection error at deploy time.
# glitchtip-worker has no healthcheck; gate on running + not-crash-looping.
wait_healthy glitchtip 90
wait_running glitchtip-worker

# --- 7. Tidy up: drop dangling images (the GHCR login is cleared by the EXIT trap). ---
docker image prune -f >/dev/null 2>&1 || true
log "deploy complete + healthy (${IMAGE_TAG})"

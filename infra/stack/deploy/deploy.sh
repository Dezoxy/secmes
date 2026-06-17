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

# --- Cross-environment knobs (ALL default to the live Azure-VM behavior; the AWS experiment sets them via the
#     cd-aws.yml run-command wrapper, the live cd.yml leaves them unset). ---
TOKEN_SOURCE="${ARGUS_TOKEN_SOURCE:-imds}"                           # imds (Azure VM MI) | arc (Arc HIMDS on EC2)
SKIP_GLITCHTIP="${ARGUS_SKIP_GLITCHTIP:-}"                           # 1 = don't run/gate the GlitchTip tier (lean box)
COSIGN_WORKFLOW="${ARGUS_COSIGN_WORKFLOW:-.github/workflows/cd.yml}" # the workflow whose run built+signed the images
ARC_IMDS_URL="http://localhost:40342/metadata/identity/oauth2/token"

log() { printf 'argus-deploy: %s\n' "$*"; } # names/status only — never a secret value

# --- Managed-Identity helpers: fetch the two deploy-TRANSIENT secrets (GHCR pull token + owner migration DSN)
#     straight from Key Vault. They are NOT part of the persistent /run/argus/secrets set the running stack
#     uses (least privilege: the stack never holds the owner DSN or a GitHub token). ---
mi_token() {
  case "$TOKEN_SOURCE" in
  imds)
    curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 -H 'Metadata: true' \
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net" |
      jq -r '.access_token // empty'
    ;;
  arc)
    # Azure Arc HIMDS challenge-token handshake (see infra/stack/secrets/fetch-keyvault-secrets.sh for the rationale):
    # 401 names a root/himds-only .key file; read it, echo back as Basic auth (via --config stdin, never argv).
    local url hdrs realm secret resp
    url="${ARC_IMDS_URL}?api-version=2020-06-01&resource=https%3A%2F%2Fvault.azure.net"
    hdrs="$(curl -sS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 -D - -o /dev/null \
      -H 'Metadata: true' "$url" | tr -d '\r')" || {
      log "FATAL: Arc HIMDS unreachable at ${ARC_IMDS_URL} (is the Arc agent Connected?)"
      return 1
    }
    realm="$(printf '%s\n' "$hdrs" | grep -i '^Www-Authenticate:' | sed -n 's/.*realm=\([^ ]*\).*/\1/p')"
    [ -n "$realm" ] || {
      log "FATAL: Arc HIMDS returned no challenge realm"
      return 1
    }
    [ -r "$realm" ] || {
      log "FATAL: cannot read Arc challenge file '${realm}' (need root or the himds group)"
      return 1
    }
    secret="$(cat "$realm")"
    resp="$(curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 -H 'Metadata: true' --config - "$url" <<EOF
header = "Authorization: Basic ${secret}"
EOF
    )" || {
      secret=""
      log "FATAL: Arc HIMDS token request failed"
      return 1
    }
    secret=""
    printf '%s' "$resp" | jq -r '.access_token // empty'
    ;;
  *)
    log "FATAL: unknown ARGUS_TOKEN_SOURCE='${TOKEN_SOURCE}'"
    return 1
    ;;
  esac
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
# at ./infra/stack/observability (relative to $COMPOSE in $APP_DIR). World-readable (0755 dirs / 0644 files) so
# the non-root prometheus/grafana container users can read it; it contains NO secrets (Grafana's admin pw is a
# Key Vault credential file, not in this tree). Refresh from the staged repo each deploy.
rm -rf "$APP_DIR/infra/stack/observability" "$APP_DIR/infra/stack/glitchtip"
install -d -m 0755 "$APP_DIR/infra/stack"
cp -a "$REPO_ROOT/infra/stack/observability" "$APP_DIR/infra/stack/observability"
chmod -R a+rX "$APP_DIR/infra/stack/observability"
# GlitchTip entrypoint wrapper — bind-mounted read-only into the glitchtip + glitchtip-worker containers.
# Contains NO secrets (reads them from Docker-secret files at runtime); world-executable so the container
# user can exec it regardless of uid.
install -d -m 0755 "$APP_DIR/infra/stack/glitchtip"
install -m 0755 "$REPO_ROOT/infra/stack/glitchtip/docker-entrypoint.sh" "$APP_DIR/infra/stack/glitchtip/docker-entrypoint.sh"
chmod a+rx "$APP_DIR/infra/stack/glitchtip/docker-entrypoint.sh"
install -m 0755 "$REPO_ROOT/infra/stack/secrets/fetch-keyvault-secrets.sh" "$APP_DIR/secrets/fetch-keyvault-secrets.sh"
install -m 0644 "$REPO_ROOT/infra/stack/secrets/argus-secrets.service" /etc/systemd/system/argus-secrets.service
# Point the unit at our fetch script + the real vault name (the repo ships a placeholder).
sed -i "s|/opt/argus/secrets/fetch-keyvault-secrets.sh|$APP_DIR/secrets/fetch-keyvault-secrets.sh|" \
  /etc/systemd/system/argus-secrets.service
sed -i "s/REPLACE_WITH_KEY_VAULT_NAME/${ARGUS_KEY_VAULT}/" /etc/systemd/system/argus-secrets.service
# The secret-fetch oneshot runs in its OWN process and does NOT inherit deploy.sh's environment, so the token
# source must be delivered to the UNIT. Default (imds) needs nothing — the script defaults to imds. For the Arc
# experiment, write a drop-in so argus-secrets.service fetches via HIMDS; clean it up if we ever revert to imds.
if [ "$TOKEN_SOURCE" != imds ]; then
  install -d -m 0755 /etc/systemd/system/argus-secrets.service.d
  printf '[Service]\nEnvironment=ARGUS_TOKEN_SOURCE=%s\n' "$TOKEN_SOURCE" \
    >/etc/systemd/system/argus-secrets.service.d/10-token-source.conf
else
  rm -f /etc/systemd/system/argus-secrets.service.d/10-token-source.conf 2>/dev/null || true
fi
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
cosign_id="https://github.com/${GH_REPO}/${COSIGN_WORKFLOW}@refs/tags/${IMAGE_TAG}"
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
#         of truth in Key Vault and lets us change the service hostname without a KV rotation.
#         Skipped entirely on the lean experiment box (SKIP_GLITCHTIP=1) — the GlitchTip tier isn't run there. ---
if [ "$SKIP_GLITCHTIP" != 1 ]; then
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
else
  # GlitchTip tier isn't running on the lean box, but compose.prod.yaml still declares the glitchtip_database_url
  # secret SOURCE — seed an empty 0444 file (mirrors the optional-secret empty-seed pattern) so a `docker compose`
  # config/secret resolution can't fail on a missing source file.
  : >"$SECRETS_DIR/glitchtip_database_url"
  chmod 0444 "$SECRETS_DIR/glitchtip_database_url"
fi

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
# Skipped on the lean experiment box (SKIP_GLITCHTIP=1).
if [ "$SKIP_GLITCHTIP" != 1 ]; then
  docker compose -f "$COMPOSE" up -d --no-deps glitchtip-db
fi
pg_cid="$(docker compose -f "$COMPOSE" ps -q postgres)"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_cid" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_cid" 2>/dev/null)" = "healthy" ] || {
  log "FATAL: Postgres did not become healthy"
  exit 1
}
# Wait for glitchtip-db separately (independent health; don't block the app-DB wait path). Skipped on the lean
# experiment box (SKIP_GLITCHTIP=1).
if [ "$SKIP_GLITCHTIP" != 1 ]; then
  gt_cid="$(docker compose -f "$COMPOSE" ps -q glitchtip-db)"
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$gt_cid" 2>/dev/null)" = "healthy" ] && break
    sleep 2
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$gt_cid" 2>/dev/null)" = "healthy" ] || {
    log "FATAL: glitchtip-db did not become healthy"
    exit 1
  }
fi

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

# --- 5b. Provision LOGIN + password for the RUNTIME roles. Migrations create argus_app/argus_cleanup/
#         argus_backup as NOLOGIN with NO password; nothing else gives them one, so the api (argus_app) and
#         the backup/cleanup workers cannot authenticate until we set a password matching the Key Vault values.
#         Do it here, right after migrate (the roles now exist) and before step 6 starts the api. Connect as
#         the owner over the postgres container's LOCAL socket (the official image trusts local), so no
#         connection password is passed anywhere; if local trust is ever disabled, psql fails and `set -e`
#         aborts the deploy (fail-closed, never serve half-provisioned). Idempotent (ALTER ROLE). ---
log "provisioning runtime role logins (argus_app/argus_cleanup/argus_backup)"
# Existence prechecks — legible FATAL on a stale/partial secret set (matches the step-3b/step-6 convention).
for _f in database_url cleanup-db-password backup-db-password; do
  [ -s "$SECRETS_DIR/$_f" ] || {
    log "FATAL: missing/empty secret file for role-login provisioning: $_f"
    exit 1
  }
done
# argus_app's password is embedded in the app DSN; cleanup/backup read their own delivered files.
_dburl="$(cat "$SECRETS_DIR/database_url")"
_app_pw="${_dburl#*://argus_app:}"
_app_pw="${_app_pw%%@*}"
_dburl=""
_cleanup_pw="$(cat "$SECRETS_DIR/cleanup-db-password")"
_backup_pw="$(cat "$SECRETS_DIR/backup-db-password")"
# ENFORCE the URL-unreserved charset (the same contract the redis/glitchtip steps enforce) BEFORE building any
# SQL. This (a) closes any single-quote -> psql syntax-error path that could echo a password fragment on
# stderr, and (b) catches a misconfigured database_url — e.g. accidentally the OWNER DSN (no `argus_app:`
# segment): the unstripped value would still contain `://` and fail here, rather than setting argus_app to a
# junk password. Logs name the roles only, never a value.
for _pw in "$_app_pw" "$_cleanup_pw" "$_backup_pw"; do
  case "$_pw" in
  '' | *[!A-Za-z0-9._~-]*)
    log "FATAL: a runtime role password is missing or contains a non-URL-safe character"
    exit 1
    ;;
  esac
done
_pw=""
# Feed the SQL on STDIN (never argv/-v) so no password reaches /proc/<pid>/cmdline; psql echoes nothing of the
# value. The owner connects over the postgres container's local socket (official-image trust) — no connection
# secret is passed; if local trust is ever disabled, psql fails and `set -e` aborts (fail-closed).
if ! docker compose -f "$COMPOSE" exec -T postgres \
  psql -U argus -d argus -v ON_ERROR_STOP=1 -q >/dev/null <<SQL; then
ALTER ROLE argus_app     WITH LOGIN PASSWORD '${_app_pw}';
ALTER ROLE argus_cleanup WITH LOGIN PASSWORD '${_cleanup_pw}';
ALTER ROLE argus_backup  WITH LOGIN PASSWORD '${_backup_pw}';
SQL
  _app_pw=""
  _cleanup_pw=""
  _backup_pw=""
  log "FATAL: failed to provision runtime role logins"
  exit 1
fi
_app_pw=""
_cleanup_pw=""
_backup_pw=""
log "runtime role logins provisioned"

# --- 6. Bring up the full stack. cloudflared's TUNNEL_TOKEN is a RUNTIME value read from the delivered Key
#        Vault file (the accepted env exception — never a committed/on-disk env file; the cloudflared image
#        has no --token-file form). ---
log "starting api + caddy + cloudflared"
# Guard: this runtime-value file must exist + be non-empty before we `cat` it into the `up` env — else
# `set -e` aborts on a bare `cat: No such file` instead of a legible FATAL. fetch-keyvault-secrets.sh (same
# bundled SHA) already fails closed first, so this is belt-and-suspenders for a stale/partial secret set.
for _f in tunnel_token; do
  [ -s "$SECRETS_DIR/$_f" ] || {
    log "FATAL: missing/empty runtime secret file: $_f"
    exit 1
  }
done
# Redis AUTH credential files (redis.conf + redis_url) were generated in step 3b and redis is already up and
# authenticated; this `up -d` only adds the remaining services. No Redis credential rides env — it's all files.
# The lean experiment box (SKIP_GLITCHTIP=1) brings up an EXPLICIT service set that excludes the GlitchTip tier
# (glitchtip + glitchtip-worker + glitchtip-db); the live default (empty list) brings up the whole stack. The
# explicit list is experiment-only + must be kept in sync if the core/observability service set changes.
if [ "$SKIP_GLITCHTIP" = 1 ]; then
  STACK_SERVICES="postgres redis api caddy cloudflared prometheus alertmanager grafana loki alloy"
else
  STACK_SERVICES=""
fi
# shellcheck disable=SC2086 # intentional word-splitting: empty STACK_SERVICES = all services; else the explicit set
TUNNEL_TOKEN="$(cat "$SECRETS_DIR/tunnel_token")" \
  docker compose -f "$COMPOSE" up -d $STACK_SERVICES
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
log "waiting for the rollout to become healthy (api, caddy, glitchtip) + the tunnel"
wait_healthy api
wait_healthy caddy
wait_running cloudflared
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
# Skipped on the lean experiment box (SKIP_GLITCHTIP=1) — the tier isn't running there.
if [ "$SKIP_GLITCHTIP" != 1 ]; then
  wait_healthy glitchtip 90
  wait_running glitchtip-worker
fi

# --- 6c. Converge the attachment bucket's CORS to the checked-in source of truth
#         (infra/b2/attachment-bucket-cors.json). Runs AFTER the stack is healthy so a B2 control-plane hiccup
#         can't block an otherwise-good rollout — but FAILS the deploy if it can't converge: a deploy that
#         re-declared the rule yet silently failed to apply it would leave browser attachment upload broken with
#         no signal but a user report. CORS is a B2 NATIVE-API setting (the S3-compatible API the stack uses
#         elsewhere can't set it), so we call the native API with curl (the box has no `b2` CLI). The credential
#         is a DEDICATED, bucket-RESTRICTED, CORS-only B2 app key (caps listBuckets,readBucketCors,
#         writeBucketCors) fetched from Key Vault as a deploy-TRANSIENT secret — never persisted to
#         /run/argus/secrets, never in env, never logged. The native API authenticates with keyId:applicationKey;
#         the keyId (B2_CORS_KEY_ID) is NON-secret env (like S3_ACCESS_KEY_ID), the key is the KV secret.
#         Idempotent: read current, write only on drift, re-verify. Activated only when B2_CORS_KEY_ID is set
#         (unset ⇒ feature not provisioned yet ⇒ skip with a log, mirroring the SKIP_* knobs — NOT a silent
#         apply failure). See docs/threat-models/b2-cors-convergence.md. ---
B2_CORS_KEY_ID="${B2_CORS_KEY_ID:-}"
ATTACHMENT_BUCKET="attachment-r8xq4m7z2p9n6k3v"
B2_AUTH_URL="https://api.backblazeb2.com/b2api/v3/b2_authorize_account"

# Single B2 native-API call. $1 = url ; $2 = Authorization header VALUE (secret; passed as a function arg, not
# argv of an exec'd process — same as kv_get — and fed to curl via --config stdin) ; $3 = optional JSON body
# (non-secret: account/bucket ids + the public CORS rule).
b2_api() {
  if [ -n "${3:-}" ]; then
    curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 \
      -H 'Content-Type: application/json' --data "$3" --config - "$1" <<EOF
header = "Authorization: ${2}"
EOF
  else
    curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 --config - "$1" <<EOF
header = "Authorization: ${2}"
EOF
  fi
}

converge_attachment_cors() {
  local cors_file="$REPO_ROOT/infra/b2/attachment-bucket-cors.json" desired
  [ -s "$cors_file" ] || {
    log "FATAL: missing CORS source of truth ($cors_file)"
    return 1
  }
  desired="$(jq -Sc '.' "$cors_file")" || {
    log "FATAL: CORS source of truth is not valid JSON"
    return 1
  }

  # Fetch the bucket-restricted CORS app key (deploy-transient; re-mint a fresh MI token — _tok was dropped
  # after migrate). The key is folded straight into the Basic credential and blanked; never logged.
  local tok key basic
  tok="$(mi_token)"
  [ -n "$tok" ] || {
    log "FATAL: no Managed Identity token for CORS convergence"
    return 1
  }
  key="$(kv_get argus-b2-cors-app-key "$tok")"
  tok=""
  [ -n "$key" ] || {
    log "FATAL: empty B2 CORS app key from Key Vault (argus-b2-cors-app-key)"
    return 1
  }
  # base64 wraps long input at 76 cols → strip newlines so the Authorization header value stays one line.
  basic="$(printf '%s:%s' "$B2_CORS_KEY_ID" "$key" | base64 | tr -d '\n')"
  key=""

  # b2_authorize_account — Basic keyId:key. Capture only the non-secret routing fields + the (secret) auth
  # token; never log the response.
  local auth api_url authtok account_id bucket_id bucket_name
  auth="$(b2_api "$B2_AUTH_URL" "Basic ${basic}")" || {
    basic=""
    log "FATAL: B2 authorize_account failed"
    return 1
  }
  basic=""
  api_url="$(printf '%s' "$auth" | jq -r '.apiInfo.storageApi.apiUrl // .apiUrl // empty')"
  authtok="$(printf '%s' "$auth" | jq -r '.authorizationToken // empty')"
  account_id="$(printf '%s' "$auth" | jq -r '.accountId // empty')"
  bucket_id="$(printf '%s' "$auth" | jq -r '.apiInfo.storageApi.bucketId // .allowed.bucketId // empty')"
  bucket_name="$(printf '%s' "$auth" | jq -r '.apiInfo.storageApi.bucketName // .allowed.bucketName // empty')"
  auth=""
  { [ -n "$api_url" ] && [ -n "$authtok" ] && [ -n "$account_id" ]; } || {
    authtok=""
    log "FATAL: B2 authorize_account returned an incomplete response"
    return 1
  }
  # The key MUST be restricted to the attachment bucket. A missing bucketId (account-wide key) or a mismatch
  # (key scoped to a DIFFERENT bucket, e.g. the db-backup bucket) is a least-privilege violation — fail closed
  # rather than risk writing CORS to the wrong bucket.
  { [ "$bucket_name" = "$ATTACHMENT_BUCKET" ] && [ -n "$bucket_id" ]; } || {
    authtok=""
    log "FATAL: B2 CORS key is not restricted to ${ATTACHMENT_BUCKET} (refusing to proceed)"
    return 1
  }

  # Read current CORS (a bucket-restricted list returns just this bucket); compare normalized.
  local cur_resp current ids_body
  ids_body="$(jq -nc --arg a "$account_id" --arg b "$bucket_id" '{accountId:$a,bucketId:$b}')"
  cur_resp="$(b2_api "${api_url}/b2api/v3/b2_list_buckets" "$authtok" "$ids_body")" || {
    authtok=""
    log "FATAL: B2 list_buckets failed"
    return 1
  }
  current="$(printf '%s' "$cur_resp" | jq -Sc '.buckets[0].corsRules // []')"
  cur_resp=""
  if [ "$current" = "$desired" ]; then
    authtok=""
    log "attachment CORS already converged"
    return 0
  fi

  # Drift — reapply, then re-verify from the update response.
  log "attachment CORS drift detected — reapplying from infra/b2/attachment-bucket-cors.json"
  local upd_body upd_resp updated
  upd_body="$(jq -nc --arg a "$account_id" --arg b "$bucket_id" --slurpfile r "$cors_file" \
    '{accountId:$a,bucketId:$b,corsRules:$r[0]}')"
  upd_resp="$(b2_api "${api_url}/b2api/v3/b2_update_bucket" "$authtok" "$upd_body")" || {
    authtok=""
    log "FATAL: B2 update_bucket failed"
    return 1
  }
  authtok=""
  updated="$(printf '%s' "$upd_resp" | jq -Sc '.corsRules // []')"
  upd_resp=""
  [ "$updated" = "$desired" ] || {
    log "FATAL: attachment CORS did not converge after update"
    return 1
  }
  log "attachment CORS reapplied + verified"
}

if [ -n "$B2_CORS_KEY_ID" ]; then
  log "converging attachment-bucket CORS"
  converge_attachment_cors || exit 1
else
  log "B2_CORS_KEY_ID not set — skipping attachment-bucket CORS convergence (provision the key to enable)"
fi

# --- 7. Tidy up: drop dangling images (the GHCR login is cleared by the EXIT trap). ---
docker image prune -f >/dev/null 2>&1 || true
log "deploy complete + healthy (${IMAGE_TAG})"

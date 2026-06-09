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

# --- 4. Bring up data services first; wait for Postgres to be healthy before migrating. ---
log "starting data services"
docker compose -f "$COMPOSE" up -d postgres redis
pg_cid="$(docker compose -f "$COMPOSE" ps -q postgres)"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_cid" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_cid" 2>/dev/null)" = "healthy" ] || {
  log "FATAL: Postgres did not become healthy"
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
TUNNEL_TOKEN="$(cat "$SECRETS_DIR/tunnel_token")" \
  ZITADEL_DB_PASSWORD="$(cat "$SECRETS_DIR/zitadel_db_password")" \
  ZITADEL_ADMIN_PASSWORD="$(cat "$SECRETS_DIR/zitadel_admin_password")" \
  docker compose -f "$COMPOSE" up -d

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
log "waiting for the rollout to become healthy (api, caddy, zitadel-db, zitadel, zitadel-login) + the tunnel"
wait_healthy api
wait_healthy caddy
wait_running cloudflared
# Zitadel exposes a real readiness probe (`zitadel ready`), so gate the DB + the API server on HEALTHY — not
# just "didn't crash". zitadel gets a longer window (150×2s=300s) for the cold first-init schema migration +
# FirstInstance seed; a bad masterkey/DB password or a stuck init fails the deploy loudly here.
wait_healthy zitadel-db
wait_healthy zitadel 150
# zitadel-login readiness depends on its Key-Vault-delivered service PAT, which is seeded during arming (empty
# on a first boot) — so gate it on running+not-crash-looping, NOT healthy, or the very first deploy (before
# the PAT exists) would fail. Its healthcheck still drives restarts; login goes healthy once the PAT lands.
wait_running zitadel-login

# --- 7. Tidy up: drop dangling images (the GHCR login is cleared by the EXIT trap). ---
docker image prune -f >/dev/null 2>&1 || true
log "deploy complete + healthy (${IMAGE_TAG})"

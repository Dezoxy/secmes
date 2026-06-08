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
kv_get() { # $1 = secret name ; $2 = bearer token
  curl -fsS --max-time 15 --retry 3 --retry-connrefused --retry-delay 2 \
    -H "Authorization: Bearer ${2}" \
    "https://${ARGUS_KEY_VAULT}.vault.azure.net/secrets/${1}?api-version=${KV_API_VERSION}" |
    jq -r '.value // empty'
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
docker pull "$API_IMAGE"
docker pull "$INGRESS_IMAGE"

export ARGUS_API_IMAGE="$API_IMAGE"
export ARGUS_INGRESS_IMAGE="$INGRESS_IMAGE"
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

# --- 6. Bring up the full stack. cloudflared's TUNNEL_TOKEN is a runtime value from the delivered file. ---
log "starting api + caddy + cloudflared"
TUNNEL_TOKEN="$(cat "$SECRETS_DIR/tunnel_token")" \
  docker compose -f "$COMPOSE" up -d

# --- 7. Tidy up: drop the registry login + dangling images. ---
docker logout "$GHCR_HOST" >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
log "deploy complete (${IMAGE_TAG})"

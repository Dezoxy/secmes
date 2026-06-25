#!/usr/bin/env bash
# argus — issue (and auto-renew) a Let's Encrypt TLS certificate for turn.4rgus.com via DNS-01 challenge.
#
# Run this ONCE after the turn.4rgus.com DNS A record is live (PR 5 apply + cloudflare-terraform merge)
# and BEFORE deploying PR 6 (which makes argus-turn-tls-cert + argus-turn-tls-key mandatory in Key Vault).
# acme.sh installs a renewal cron that re-runs ~60 days; the deploy hook re-uploads to Key Vault + reloads
# coturn without dropping active calls (SIGHUP triggers a graceful credential reload, not a process restart).
#
# Prerequisites:
#   - az CLI logged in as a principal with Key Vault Secrets Officer on the target vault.
#   - ARGUS_KEY_VAULT: the Key Vault name (or pass --vault <name>). Get it:
#       terraform -chdir=infra/aws/terraform output -raw key_vault_name
#   - CF_Token: Cloudflare API token with Zone:DNS:Edit on 4rgus.com (prompted on a TTY if unset).
#     Create at: Cloudflare Dashboard → Profile → API Tokens → Create Token → "Edit zone DNS" template,
#     scope to zone 4rgus.com. This is a token, NOT the global API key — narrower scope, revocable.
#   - curl, openssl (standard on macOS/Linux), acme.sh (see --install-acme below).
#   - The VM's Managed Identity does NOT have Key Vault write access; run this from your WORKSTATION
#     as an admin with the "Key Vault Secrets Officer" role (granted via var.admin_object_id in Terraform).
#
# Usage:
#   export ARGUS_KEY_VAULT=<your-key-vault-name>   # gitleaks:allow (non-secret KV name, no value)
#   export CF_Token=<cloudflare-token>              # or omit to be prompted
#   ./issue-turn-cert.sh [--vault <name>] [--renew] [--install-acme]
#
#   --vault <name>   Override ARGUS_KEY_VAULT.
#   --renew          Force renewal even if the cert has >30 days remaining.
#   --install-acme   Install acme.sh from get.acme.sh before running (opt-in; see supply-chain note below).
set -euo pipefail

DOMAIN="turn.4rgus.com"
ACME_HOME="${ACME_HOME:-/opt/acme.sh}"
ACME="${ACME_HOME}/acme.sh"
KV="${ARGUS_KEY_VAULT:-}"
FORCE_RENEW=0
INSTALL_ACME=0

while [ $# -gt 0 ]; do
  case "$1" in
  --vault)
    KV="${2:?--vault needs a value}"
    shift 2
    ;;
  --renew)
    FORCE_RENEW=1
    shift
    ;;
  --install-acme)
    INSTALL_ACME=1
    shift
    ;;
  *)
    echo "unknown arg: $1" >&2
    exit 2
    ;;
  esac
done

# Prefer terraform output if KV not set.
if [ -z "$KV" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  KV="$(terraform -chdir="${SCRIPT_DIR}/../../aws/terraform" output -raw key_vault_name 2>/dev/null || true)"
fi
[ -n "$KV" ] || {
  echo "FATAL: no vault name — set ARGUS_KEY_VAULT, pass --vault, or run after 'terraform apply'" >&2
  exit 1
}

log() { printf 'issue-turn-cert: %s\n' "$*"; }

command -v az >/dev/null || {
  log "FATAL: az CLI not found (https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)"
  exit 1
}
command -v curl >/dev/null || {
  log "FATAL: curl not found"
  exit 1
}

# Prompt for CF_Token on a TTY if not set — never via argv, never logged.
if [ -z "${CF_Token:-}" ]; then
  [ -t 0 ] || {
    log "FATAL: CF_Token unset and no TTY — export CF_Token=<cloudflare-api-token> before running"
    exit 1
  }
  read -rsp "  Cloudflare API token (Zone:DNS:Edit on 4rgus.com): " CF_Token
  echo
fi
[ -n "${CF_Token:-}" ] || {
  log "FATAL: CF_Token is empty"
  exit 1
}
export CF_Token  # acme.sh reads this from the environment; it is not logged

# Install acme.sh only when explicitly requested (--install-acme). Piping a remote installer to sh is a
# supply-chain risk on a machine with Key Vault Secrets Officer. Default: require acme.sh to be
# pre-installed (e.g. via the GitHub release tarball at a pinned tag, or a package manager).
if [ ! -x "$ACME" ]; then
  if [ "$INSTALL_ACME" -eq 1 ]; then
    log "installing acme.sh from get.acme.sh into ${ACME_HOME} ..."
    curl -fsSL https://get.acme.sh | sh -s -- --home "$ACME_HOME" --nocron 2>&1 | grep -v 'acme.sh:'
    log "acme.sh installed at ${ACME_HOME}"
  else
    log "FATAL: acme.sh not found at ${ACME} — install it first, then re-run."
    log "  Option A (recommended): download a pinned release from https://github.com/acmesh-official/acme.sh/releases"
    log "  Option B (quick): re-run with --install-acme to pipe get.acme.sh | sh (understand the supply-chain risk)"
    exit 1
  fi
fi

# Secret values land in a 0700 tmp dir — removed on any exit (success or failure).
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT
umask 0077

CERT_FILE="${WORKDIR}/fullchain.pem"
KEY_FILE="${WORKDIR}/privkey.pem"

# --- Write the deploy hook BEFORE issuing so acme.sh can invoke it on the first --issue. ---
# The hook is stored in ACME_HOME/deploy/ (acme.sh's built-in deploy-hook location).
# KV name is baked in at write time — ARGUS_KEY_VAULT won't exist in acme.sh's cron environment.
HOOK_SCRIPT="${ACME_HOME}/deploy/argus-turn-cert.sh"
mkdir -p "${ACME_HOME}/deploy"
# Conf file holds the vault name for the hook. Mode 0600: world-unreadable, not in env.
printf 'ARGUS_KEY_VAULT=%s\n' "$KV" >"${ACME_HOME}/deploy/argus-turn.conf"
chmod 0600 "${ACME_HOME}/deploy/argus-turn.conf"
log "baked vault name into ${ACME_HOME}/deploy/argus-turn.conf"

cat >"$HOOK_SCRIPT" <<'HOOK'
#!/usr/bin/env bash
# acme.sh deploy hook — called after each successful renewal of turn.4rgus.com.
# Re-uploads the fresh cert + key to Key Vault and sends coturn SIGHUP (graceful reload).
# acme.sh passes: $Le_Domain $CERT_PATH $CERT_KEY_PATH $CERT_FULLCHAIN_PATH $CERT_PFLS_PATH
set -euo pipefail

# Source the vault name baked in at issue time — not present in acme.sh's cron environment.
# shellcheck source=deploy/argus-turn.conf
CONF="$(dirname "${BASH_SOURCE[0]}")/argus-turn.conf"
[ -r "$CONF" ] || { printf 'FATAL: argus-turn.conf missing at %s\n' "$CONF" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
KV="${ARGUS_KEY_VAULT:?ARGUS_KEY_VAULT not set in argus-turn.conf}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT
umask 0077
CERT_TMP="${WORKDIR}/fullchain.pem"
KEY_TMP="${WORKDIR}/privkey.pem"

# acme.sh deploy-hook variables: $CERT_FULLCHAIN_PATH (fullchain), $CERT_KEY_PATH (private key).
cp "$CERT_FULLCHAIN_PATH" "$CERT_TMP"
cp "$CERT_KEY_PATH" "$KEY_TMP"

az keyvault secret set --vault-name "$KV" --name "argus-turn-tls-cert" \
  --file "$CERT_TMP" --encoding utf-8 --only-show-errors >/dev/null
az keyvault secret set --vault-name "$KV" --name "argus-turn-tls-key" \
  --file "$KEY_TMP" --encoding utf-8 --only-show-errors >/dev/null
: >"$KEY_TMP"

# Signal coturn to gracefully reload TLS credentials without dropping active relay allocations.
# PR 7 adds the coturn Compose service; || true is correct — coturn may not be deployed yet.
docker kill -s HUP coturn 2>/dev/null || true

printf 'argus-turn-cert deploy hook: cert renewed and uploaded to Key Vault %s\n' "$KV"
HOOK
chmod 0750 "$HOOK_SCRIPT"
log "deploy hook written to ${HOOK_SCRIPT}"

# --- Issue or renew ---
RENEW_FLAGS=()
[ "$FORCE_RENEW" -eq 1 ] && RENEW_FLAGS=(--force)

log "running acme.sh --issue for ${DOMAIN} (dns_cf / Let's Encrypt)..."
"$ACME" --issue --dns dns_cf -d "$DOMAIN" --server letsencrypt \
  --home "$ACME_HOME" \
  --fullchain-file "$CERT_FILE" \
  --key-file "$KEY_FILE" \
  --deploy-hook argus-turn-cert \
  "${RENEW_FLAGS[@]}" || {
  EXIT=$?
  # acme.sh exit 2 = cert already valid and not yet due for renewal (not an error in normal runs).
  if [ $EXIT -eq 2 ] && [ "$FORCE_RENEW" -eq 0 ]; then
    log "cert is still valid — use --renew to force. Uploading the existing cert from acme.sh store."
    # Retrieve from the acme.sh cert store (ECC preferred, RSA fallback).
    CERT_DIR="${ACME_HOME}/${DOMAIN}_ecc"
    [ -d "$CERT_DIR" ] || CERT_DIR="${ACME_HOME}/${DOMAIN}"
    cp "${CERT_DIR}/fullchain.cer" "$CERT_FILE"
    cp "${CERT_DIR}/${DOMAIN}.key" "$KEY_FILE"
  else
    log "FATAL: acme.sh exited $EXIT"
    exit $EXIT
  fi
}

# Validate cert before uploading: check it covers the right domain and isn't already expired.
openssl x509 -noout -checkend 0 -in "$CERT_FILE" || {
  log "FATAL: issued cert is expired or invalid"
  exit 1
}
openssl x509 -noout -text -in "$CERT_FILE" | grep -q "$DOMAIN" || {
  log "FATAL: issued cert does not cover ${DOMAIN}"
  exit 1
}

# Upload cert + key to Key Vault via --file (never argv — values never appear in ps/cmdline).
log "uploading argus-turn-tls-cert → Key Vault ${KV}..."
az keyvault secret set --vault-name "$KV" --name "argus-turn-tls-cert" \
  --file "$CERT_FILE" --encoding utf-8 --only-show-errors >/dev/null
log "uploading argus-turn-tls-key → Key Vault ${KV}..."
az keyvault secret set --vault-name "$KV" --name "argus-turn-tls-key" \
  --file "$KEY_FILE" --encoding utf-8 --only-show-errors >/dev/null

# Wipe private key from the workdir immediately (trap cleans the dir, but belt-and-suspenders).
: >"$KEY_FILE"

log "cert + key uploaded. Verifying..."
az keyvault secret show --vault-name "$KV" --name "argus-turn-tls-cert" \
  --query "value" -o tsv --only-show-errors | openssl x509 -noout -subject -dates
log "Key Vault delivery verified."

# Install acme.sh's renewal cron.
"$ACME" --install-cronjob --home "$ACME_HOME" 2>/dev/null || true

log ""
log "Done. Next steps:"
log "  1. Run populate-keyvault.sh to provision argus-turn-shared-secret (if not already done)."
log "  2. Deploy PR 6: argus-secrets will deliver turn_shared_secret + turn_tls_cert + turn_tls_key"
log "     to /run/argus/secrets/ on the next 'systemctl restart argus-secrets'."
log "  3. Merge and deploy PR 7 (coturn service). coturn reads the files from /run/argus/secrets/."
log "  Renewal: acme.sh cron runs ~60 days. The deploy hook re-uploads to KV + signals coturn."
log "  To verify renewal manually: acme.sh --info -d ${DOMAIN} | grep Hook"

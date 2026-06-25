#!/bin/sh
# Resolve external-ip from IMDS (AWS IMDSv2 → Azure IMDS → env override) and inject the
# HMAC shared secret from the Docker secret file before exec-ing turnserver.
# Runs as nobody (uid 65534). Fail closed if external-ip cannot be determined.
set -eu

log() { printf '[coturn-entrypoint] %s\n' "$*"; }

if [ -n "${ARGUS_TURN_EXTERNAL_IP:-}" ]; then
  EXT_IP="$ARGUS_TURN_EXTERNAL_IP"
  log "external-ip set from ARGUS_TURN_EXTERNAL_IP env override"
else
  EXT_IP=""

  # Guard: IMDS probing requires curl. Without this check, a missing curl binary silently
  # suppresses "command not found" via the || guards and emits a misleading "could not resolve"
  # error instead of the real cause.
  if ! command -v curl >/dev/null 2>&1; then
    log "FATAL: curl not found in this image; set ARGUS_TURN_EXTERNAL_IP to skip IMDS probing"
    exit 1
  fi

  # AWS IMDSv2: fetch token first, then public + private IPs.
  TOKEN=$(curl -sf -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token 2>/dev/null) || TOKEN=""
  if [ -n "$TOKEN" ]; then
    PUB=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
      http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null) || PUB=""
    PRIV=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
      http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null) || PRIV=""
    if [ -n "$PUB" ] && [ -n "$PRIV" ]; then
      EXT_IP="${PUB}/${PRIV}"
      log "external-ip resolved from AWS IMDSv2"
    fi
  fi

  # Azure IMDS fallback (also used by Arc-connected EC2 when AWS IMDS is not the primary path).
  if [ -z "$EXT_IP" ]; then
    PUB=$(curl -sf -H 'Metadata: true' \
      'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' \
      2>/dev/null) || PUB=""
    PRIV=$(curl -sf -H 'Metadata: true' \
      'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/privateIpAddress?api-version=2021-02-01&format=text' \
      2>/dev/null) || PRIV=""
    if [ -n "$PUB" ] && [ -n "$PRIV" ]; then
      EXT_IP="${PUB}/${PRIV}"
      log "external-ip resolved from Azure IMDS"
    fi
  fi

  if [ -z "$EXT_IP" ]; then
    log "FATAL: could not resolve external-ip from IMDS; set ARGUS_TURN_EXTERNAL_IP"
    exit 1
  fi
fi

# turnserver has no *_FILE env support. Write the secret to a 0600 tmpfs config fragment so it
# never appears in argv (/proc/<pid>/cmdline). /var/tmp is a tmpfs mounted by compose.
SECRET=$(cat /run/secrets/turn_shared_secret)
(umask 077 && printf 'static-auth-secret=%s\n' "$SECRET" > /var/tmp/coturn-auth.conf)
SECRET=""

log "launching turnserver"
exec turnserver \
  -c /etc/coturn/turnserver.conf \
  -c /var/tmp/coturn-auth.conf \
  --external-ip="${EXT_IP}"

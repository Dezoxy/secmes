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

# turnserver has no *_FILE env support — read the secret from the Docker secret file and pass
# it as a CLI flag (overrides any value in turnserver.conf). Visible to root in /proc on the
# host; accepted risk for a single-tenant VM.
SECRET=$(cat /run/secrets/turn_shared_secret)

log "launching turnserver"
exec turnserver \
  -c /etc/coturn/turnserver.conf \
  --external-ip="${EXT_IP}" \
  --static-auth-secret="${SECRET}"

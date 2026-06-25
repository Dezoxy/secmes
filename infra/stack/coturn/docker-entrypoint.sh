#!/bin/sh
# Resolve external-ip and inject HMAC shared secret before exec-ing turnserver.
# Runs as nobody (uid 65534). Fail closed if external-ip cannot be determined.
# Resolution order: ARGUS_TURN_EXTERNAL_IP env → curl AWS IMDSv2 → curl Azure IMDS → detect-external-ip.
# curl-based IMDS is preferred because it produces the pub/priv form (public/private) that coturn
# needs to resolve NAT correctly. detect-external-ip returns only the bare public IP and is kept
# as a final fallback for non-cloud environments where NAT is not a factor.
set -eu

log() { printf '[coturn-entrypoint] %s\n' "$*"; }

if [ -n "${ARGUS_TURN_EXTERNAL_IP:-}" ]; then
  EXT_IP="$ARGUS_TURN_EXTERNAL_IP"
  log "external-ip set from ARGUS_TURN_EXTERNAL_IP env override"
else
  EXT_IP=""

  # Prefer curl-based IMDS: it builds pub/priv form so coturn maps NAT correctly on AWS and Azure.
  if command -v curl >/dev/null 2>&1; then
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

    # Azure IMDS (also used by Arc-connected EC2 when AWS IMDS is not the primary path).
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
  fi

  # Fall back to detect-external-ip (bundled; returns bare public IP — acceptable in non-NAT
  # environments such as local testing where IMDS is unavailable).
  if [ -z "$EXT_IP" ] && command -v detect-external-ip >/dev/null 2>&1; then
    EXT_IP=$(detect-external-ip 2>/dev/null) || EXT_IP=""
    if [ -n "$EXT_IP" ]; then
      log "external-ip resolved via detect-external-ip (bare public IP; use ARGUS_TURN_EXTERNAL_IP=pub/priv for NAT)"
    fi
  fi

  if [ -z "$EXT_IP" ]; then
    log "FATAL: could not resolve external-ip; set ARGUS_TURN_EXTERNAL_IP"
    exit 1
  fi
fi

# turnserver does not merge repeated -c flags — the last one wins. Build a single combined
# config on tmpfs: the bind-mounted main config + the secret appended at the end.
# The secret never appears in argv (/proc/<pid>/cmdline). /var/tmp is a tmpfs mounted by compose.
SECRET=$(cat /run/secrets/turn_shared_secret)
(umask 077 && {
  cat /etc/coturn/turnserver.conf
  printf 'static-auth-secret=%s\n' "$SECRET"
} > /var/tmp/turnserver-combined.conf)
SECRET=""

log "launching turnserver"
exec turnserver \
  -c /var/tmp/turnserver-combined.conf \
  --external-ip="${EXT_IP}"

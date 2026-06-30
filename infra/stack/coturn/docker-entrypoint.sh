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

# --- Peer-ACL exception for single-server relay-to-relay ------------------------------------------
# VoIP V1 is relay-only, so both legs of a 1:1 call allocate on THIS coturn and each must open a
# media path to the other's relayed address — which is our own public IP. coturn back-translates
# that to our PRIVATE IP before the peer ACL runs, and turnserver.conf denies all of 10/8 (SSRF
# guard), so the legitimate hairpin is refused with 403 unless we explicitly allow our own private
# IP. We pair it with an explicit deny of our own PUBLIC IP to close self-public loopback
# amplification (see docs/threat-models/voip-turn.md). allowed-peer-ip overrides denied-peer-ip for
# that exact /32; every other private range stays denied. Safety rests on no-tcp-relay (UDP only,
# our own IP only). Resolved here, never hardcoded in the bind-mounted conf.
PUB_IP="${EXT_IP%%/*}" # external-ip may be "pub" or "pub/priv"; the public half is before any "/"

if [ -n "${ARGUS_TURN_PRIVATE_IP:-}" ]; then
  PRIV_IP="$ARGUS_TURN_PRIVATE_IP"
  log "private-ip set from ARGUS_TURN_PRIVATE_IP env override"
elif [ "$EXT_IP" != "$PUB_IP" ]; then
  PRIV_IP="${EXT_IP#*/}" # pub/priv form already carries the private half
  log "private-ip taken from external-ip pub/priv form"
else
  # hostname -i yields the host IPs (curl/iproute2 are absent from the image). Pick the first
  # non-loopback IPv4; the validation below fails closed if none is found.
  PRIV_IP="$(hostname -i 2>/dev/null | tr ' ' '\n' \
    | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | grep -vE '^127\.' | head -n1)"
  log "private-ip resolved via hostname -i"
fi

# Fail closed: PRIV_IP must be a real, non-loopback, non-wildcard IPv4 (each octet 0-255). A
# wrong/empty value would either break relaying or (worse) widen the ACL, so refuse to launch
# rather than guess. The anchored pattern also rejects any whitespace/`;`/`/` (no arg injection).
_octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
if ! printf '%s' "$PRIV_IP" | grep -qE "^(${_octet}\.){3}${_octet}$" \
   || printf '%s' "$PRIV_IP" | grep -qE '^(127\.|0\.0\.0\.0$)'; then
  log "FATAL: could not resolve a valid private-ip (got '${PRIV_IP:-}'); set ARGUS_TURN_PRIVATE_IP"
  exit 1
fi

# Degenerate no-NAT case (pub == priv, e.g. a bare external-ip on a single-homed non-cloud host):
# emitting allow==deny for the same IP lets the allow win and we'd relay to our own address — the
# self-loopback the deny exists to close. Never happens on the pub≠priv cloud path; fail closed.
if [ "$PRIV_IP" = "$PUB_IP" ]; then
  log "FATAL: private-ip equals public-ip (${PRIV_IP}); cannot form a safe peer-ACL"
  exit 1
fi

# Auto-detection is best-effort; on a multi-NIC host hostname -i may pick the wrong address — set
# ARGUS_TURN_PRIVATE_IP (authoritative) in that case. hostname is confirmed present in coturn 4.6.2.
log "peer-ACL: allow private ${PRIV_IP} (same-server relay), deny public ${PUB_IP} (self-loopback)"

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
  --external-ip="${EXT_IP}" \
  --allowed-peer-ip="${PRIV_IP}" \
  --denied-peer-ip="${PUB_IP}"

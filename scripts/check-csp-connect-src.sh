#!/usr/bin/env bash
set -euo pipefail

# CI guard (CSP-1 / CSP-3): pin the Caddyfile CSP `connect-src` B2 egress to the single prod attachment
# bucket's virtual-host subdomain, and keep that bucket in sync with deploy.sh's ATTACHMENT_BUCKET.
#
# Why this matters: a CSP source expression is host-only — it cannot restrict the path. The old
# `connect-src` listed both a wildcard `*.s3.eu-central-003.backblazeb2.com` and the bare path-style host
# `s3.eu-central-003.backblazeb2.com`; the bare host let in-origin code POST to ANY bucket in the shared
# region namespace (an exfil egress). This guard fails the build if either re-appears, or if the pinned
# bucket host drifts from the bucket deploy.sh actually provisions.

CADDYFILE="infra/stack/caddy/Caddyfile"
DEPLOY_SH="infra/stack/deploy/deploy.sh"
REGION_SUFFIX="s3.eu-central-003.backblazeb2.com"

fail=0

# The single connect-src line in the Caddyfile.
csp_line=$(grep -E 'Content-Security-Policy.*connect-src' "$CADDYFILE" || true)
if [ -z "$csp_line" ]; then
  echo "::error::no Content-Security-Policy connect-src line found in $CADDYFILE"
  exit 1
fi

# The bucket deploy.sh provisions and presigns against.
bucket=$(grep -E '^ATTACHMENT_BUCKET=' "$DEPLOY_SH" | head -1 | sed -E 's/^ATTACHMENT_BUCKET="?([^"]+)"?.*/\1/')
if [ -z "$bucket" ]; then
  echo "::error::could not read ATTACHMENT_BUCKET from $DEPLOY_SH"
  exit 1
fi
expected_host="https://${bucket}.${REGION_SUFFIX}"

# 1. The pinned virtual-host bucket subdomain must be present.
if ! printf '%s' "$csp_line" | grep -qF "$expected_host"; then
  echo "::error::connect-src must allow the pinned bucket host $expected_host (matching ATTACHMENT_BUCKET=$bucket)"
  fail=1
fi

# 2. The wildcard subdomain must NOT be present.
if printf '%s' "$csp_line" | grep -qE "https://\*\.${REGION_SUFFIX//./\\.}"; then
  echo "::error::connect-src must NOT allow the wildcard https://*.${REGION_SUFFIX} (CSP-1: shared-namespace exfil egress)"
  fail=1
fi

# 3. The bare path-style region endpoint must NOT be present (host-only CSP cannot restrict its path).
if printf '%s' "$csp_line" | grep -qE "https://${REGION_SUFFIX//./\\.}([^.a-z0-9-]|\$)"; then
  echo "::error::connect-src must NOT allow the bare path-style host https://${REGION_SUFFIX} (CSP-1: path-style reaches any bucket)"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "CSP connect-src: pinned to $expected_host; no wildcard, no path-style host"

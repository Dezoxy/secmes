#!/usr/bin/env bash
set -euo pipefail

# CI guard (companion to compose-guard): the secret-exclude block — the lines between the
# `# argus-secret-excludes >>>` and `# argus-secret-excludes <<<` markers — must be byte-identical in EVERY
# *dockerignore. A per-Dockerfile <name>.dockerignore REPLACES the root .dockerignore for that build (BuildKit
# does not merge them), so if a secret-path exclusion silently drifts out of one of them, that image's build
# context could capture a credential file. This prints only file names + region hashes — never the patterns.

files=(
  ".dockerignore"
  "apps/api/Dockerfile.dockerignore"
  "infra/stack/caddy/Dockerfile.dockerignore"
)

extract() {
  awk '/argus-secret-excludes >>>/{f=1; next} /argus-secret-excludes <<</{f=0} f' "$1"
}

ref=""
fail=0
for f in "${files[@]}"; do
  if ! extract "$f" | grep -q .; then
    echo "::error::$f is missing the 'argus-secret-excludes' marker block"
    fail=1
    continue
  fi
  h=$(extract "$f" | openssl dgst -sha256 | awk '{print $NF}')
  echo "  $f  sha256:$h"
  if [ -z "$ref" ]; then
    ref="$h"
  elif [ "$h" != "$ref" ]; then
    echo "::error::$f secret-exclude block differs from ${files[0]} — keep every *dockerignore secret block byte-identical"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "dockerignore secret-exclude blocks: in sync"

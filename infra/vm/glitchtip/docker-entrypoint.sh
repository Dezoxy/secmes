#!/bin/sh
# Read GlitchTip runtime secrets from mounted Docker-secret files into env.
# GlitchTip (Django) has no native `_FILE` env support, so we source the files
# here and exec the original command — secrets are never committed or in argv.
set -e
export DATABASE_URL="$(cat /run/secrets/glitchtip_database_url)"
export SECRET_KEY="$(cat /run/secrets/glitchtip_secret_key)"
export REDIS_URL="$(cat /run/secrets/redis_url)"
exec "$@"

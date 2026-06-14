#!/bin/sh
# Provision the local Zitadel instance for argus (LOCAL DEV ONLY). Idempotent: safe to re-run.
# Uses the bootstrap machine PAT (written by FirstInstance to /bootstrap/admin.pat) against the
# Management API to create — if absent — the project, the SPA (User-Agent, PKCE, JWT access tokens)
# OIDC app, and the token Action that asserts email/name claims onto the access token
# (Complement-Token flow → Pre-Access-Token trigger). Writes the generated client/project
# ids to /bootstrap/{api,web}.env.local for the Makefile to materialise on the host.
#
# NOTE: the `tenant_id` claim was removed in G1 (0018_tenant_onboarding). Tenant lookup now uses
# the user_tenant_index DB table keyed by `sub` — no JWT claim needed.
#
# Every value here is a LOCAL throwaway — never a real secret. Verified against Zitadel v4.15.0.
set -eu

BASE="http://zitadel:8080"            # compose DNS; Host header is zitadel:8080 → matches ExternalDomain
PROJECT_NAME="argus"
APP_NAME="argus-web"
ACTION_NAME="argusClaims"
REDIRECT_URI="http://localhost:5173/auth/callback"
POST_LOGOUT_URI="http://localhost:5173/"
LOGIN_UI_BASE_URI="http://zitadel:3001/ui/v2/login"
# Zitadel flow/trigger ids (global enums): flow 2 = Complement Token, trigger 5 = Pre Access Token Creation.
FLOW_COMPLEMENT_TOKEN=2
TRIGGER_PRE_ACCESS_TOKEN=5

log() { echo "[provision] $*"; }

# 1) Wait for the OP discovery endpoint, then read the bootstrap PAT.
log "waiting for Zitadel discovery..."
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/.well-known/openid-configuration")" = "200" ]; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { log "FATAL: Zitadel not ready after 120s"; exit 1; }
  sleep 2
done
[ -s /bootstrap/admin.pat ] || { log "FATAL: /bootstrap/admin.pat missing (FirstInstance did not run?)"; exit 1; }
PAT="$(cat /bootstrap/admin.pat)"
log "Zitadel ready; PAT loaded."

# zcurl METHOD PATH [json-body]  → response body on stdout
zcurl() {
  _m="$1"; _p="$2"; _b="${3:-}"
  if [ -n "$_b" ]; then
    curl -s -X "$_m" -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
      "$BASE$_p" -d "$_b"
  else
    curl -s -X "$_m" -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' "$BASE$_p"
  fi
}

zconnect() {
  _p="$1"; _b="$2"
  curl -s -X POST -H "Authorization: Bearer $PAT" -H 'Connect-Protocol-Version: 1' \
    -H 'Content-Type: application/json' "$BASE$_p" -d "$_b"
}

log "waiting for Zitadel Management API..."
i=0
until zcurl POST /management/v1/projects/_search '{"queries":[]}' | jq -e '.details' >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { log "FATAL: Management API not ready after 120s"; exit 1; }
  sleep 2
done
log "Management API ready."

# 2) Project (search-first for idempotency — Zitadel does not enforce unique project names).
PROJECT_ID="$(zcurl POST /management/v1/projects/_search \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"$PROJECT_NAME\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}" \
  | jq -r '.result[0].id // empty')"
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(zcurl POST /management/v1/projects "{\"name\":\"$PROJECT_NAME\"}" | jq -r '.id')"
  log "created project $PROJECT_ID"
else
  log "reusing project $PROJECT_ID"
fi
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || { log "FATAL: no project id"; exit 1; }

# 3) Simple Hosted Login branding: keep Zitadel's Login V2 app, but make it use Argus colors.
LABEL_POLICY_BODY="$(jq -n \
  --arg primary '#9333ea' \
  --arg warn '#f43f5e' \
  --arg background '#f8fafc' \
  --arg font '#111827' \
  --arg primaryDark '#a855f7' \
  --arg warnDark '#fb7185' \
  --arg backgroundDark '#12121a' \
  --arg fontDark '#f8fafc' \
  '{
    primaryColor: $primary,
    warnColor: $warn,
    backgroundColor: $background,
    fontColor: $font,
    primaryColorDark: $primaryDark,
    warnColorDark: $warnDark,
    backgroundColorDark: $backgroundDark,
    fontColorDark: $fontDark,
    disableWatermark: true,
    themeMode: "THEME_MODE_DARK"
  }')"
LABEL_IS_DEFAULT="$(zcurl GET /management/v1/policies/label | jq -r '.isDefault // .policy.isDefault // false')"
if [ "$LABEL_IS_DEFAULT" = "true" ]; then
  zcurl POST /management/v1/policies/label "$LABEL_POLICY_BODY" >/dev/null
else
  zcurl PUT /management/v1/policies/label "$LABEL_POLICY_BODY" >/dev/null
fi
zcurl POST /management/v1/policies/label/_activate '{}' >/dev/null
zconnect /zitadel.project.v2.ProjectService/UpdateProject "$(jq -n --arg id "$PROJECT_ID" \
  '{projectId: $id, privateLabelingSetting: "PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY"}')" >/dev/null
log "configured Argus branding for Login V2"

# 4) Hosted Login V2 text overrides. Settings V2 merges these keys with the default locale file.
LOGIN_TRANSLATION_BODY="$(jq -n \
  --arg title 'Welcome to Argus' \
  --arg description 'Use your device passkey to open secure messaging.' \
  '{
    instance: true,
    locale: "en",
    translations: {
      loginname: {
        title: $title,
        description: $description
      }
    }
  }')"
zcurl PUT /v2/settings/hosted_login_translation "$LOGIN_TRANSLATION_BODY" >/dev/null
log "configured Argus hosted login copy"

# 5) SPA OIDC app (User-Agent + PKCE + JWT access tokens; devMode allows the http localhost redirect).
APP_JSON="$(zcurl POST "/management/v1/projects/$PROJECT_ID/apps/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"$APP_NAME\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")"
CLIENT_ID="$(echo "$APP_JSON" | jq -r '.result[0].oidcConfig.clientId // empty')"
if [ -z "$CLIENT_ID" ]; then
  CREATE_APP="$(zcurl POST "/management/v1/projects/$PROJECT_ID/apps/oidc" "$(cat <<JSON
{
  "name": "$APP_NAME",
  "redirectUris": ["$REDIRECT_URI"],
  "postLogoutRedirectUris": ["$POST_LOGOUT_URI"],
  "responseTypes": ["OIDC_RESPONSE_TYPE_CODE"],
  "grantTypes": ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
  "appType": "OIDC_APP_TYPE_USER_AGENT",
  "authMethodType": "OIDC_AUTH_METHOD_TYPE_NONE",
  "version": "OIDC_VERSION_1_0",
  "devMode": true,
  "accessTokenType": "OIDC_TOKEN_TYPE_JWT",
  "accessTokenRoleAssertion": true
}
JSON
)")"
  CLIENT_ID="$(echo "$CREATE_APP" | jq -r '.clientId')"
  log "created app, clientId $CLIENT_ID"
else
  log "reusing app, clientId $CLIENT_ID"
fi
[ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "null" ] || { log "FATAL: no client id"; exit 1; }

# --- Access-token lifetime (COMP-6 — see docs/threat-models/auth-tenant-context.md §6) ----------------
# Pin a SHORT access-token TTL so the threat model's "short TTL bounds in-window token replay" mitigation is
# real (Zitadel's default is 12h = 43200s). This is an INSTANCE-level OIDC setting on the Admin API
# (PUT /admin/v1/settings/oidc — endpoint + behaviour verified against v4.15.0), NOT part of the per-app
# config above. UpdateOIDCSettings is a FULL update, so GET the current settings and override ONLY
# accessTokenLifetime (preserving the id/refresh lifetimes) before PUTting it back.
ACCESS_TOKEN_TTL="${ACCESS_TOKEN_TTL:-900s}" # 15 min
OIDC_CUR="$(zcurl GET /admin/v1/settings/oidc | jq -c '.settings // {}')"
OIDC_BODY="$(echo "$OIDC_CUR" | jq -c --arg ttl "$ACCESS_TOKEN_TTL" \
  '{accessTokenLifetime: $ttl,
    idTokenLifetime:            (.idTokenLifetime            // "43200s"),
    refreshTokenIdleExpiration: (.refreshTokenIdleExpiration // "2592000s"),
    refreshTokenExpiration:     (.refreshTokenExpiration     // "7776000s")}')"
zcurl PUT /admin/v1/settings/oidc "$OIDC_BODY" >/dev/null
log "pinned access-token lifetime = $ACCESS_TOKEN_TTL (Zitadel default is 12h)"
# PRODUCTION REQUIREMENT: this script runs LOCAL only. The prod Zitadel instance MUST get the same setting —
# the identical PUT /admin/v1/settings/oidc against prod (with a prod admin token) is the binding control for
# the in-window-replay residual. Nothing else in this repo can set it.

# 6) Token Action: assert email/name claims from the user onto the access token.
#    The function name MUST equal the action name. setClaim only sets if the key is absent.
#    tenant_id claim removed in G1 — tenant lookup is now via user_tenant_index DB table.
ACTION_SCRIPT="function $ACTION_NAME(ctx, api) { var u = ctx.v1.getUser(); if (u && u.human) { if (u.human.isEmailVerified && u.human.email) { api.v1.claims.setClaim('email', u.human.email); } if (u.human.displayName) { api.v1.claims.setClaim('name', u.human.displayName); } } }"
ACTION_BODY="$(jq -n --arg n "$ACTION_NAME" --arg s "$ACTION_SCRIPT" \
  '{name:$n, script:$s, timeout:"10s", allowedToFail:false}')"
ACTION_ID="$(zcurl POST /management/v1/actions/_search '{}' \
  | jq -r --arg n "$ACTION_NAME" '.result[]? | select(.name==$n) | .id' | head -n1)"
if [ -z "$ACTION_ID" ]; then
  ACTION_ID="$(zcurl POST /management/v1/actions "$ACTION_BODY" | jq -r '.id')"
  log "created action $ACTION_ID"
else
  zcurl PUT "/management/v1/actions/$ACTION_ID" "$ACTION_BODY" >/dev/null
  log "updated action $ACTION_ID"
fi
[ -n "$ACTION_ID" ] && [ "$ACTION_ID" != "null" ] || { log "FATAL: no action id"; exit 1; }

# 7) Bind the action to Complement-Token → Pre-Access-Token-Creation (replaces the set, so idempotent).
zcurl POST "/management/v1/flows/$FLOW_COMPLEMENT_TOKEN/trigger/$TRIGGER_PRE_ACCESS_TOKEN" \
  "{\"actionIds\":[\"$ACTION_ID\"]}" >/dev/null
log "bound action to Complement-Token / Pre-Access-Token-Creation"

# 8) Zitadel v4 hosts Login V2 as a separate app. Point browser login redirects at the local
#    `zitadel-login` container instead of the missing in-binary `/ui/v2/login` path.
zcurl PUT /v2/features/instance \
  "{\"loginV2\":{\"required\":true,\"baseUri\":\"$LOGIN_UI_BASE_URI\"}}" >/dev/null
log "configured Login V2 base URI $LOGIN_UI_BASE_URI"

# 9) Emit env fragments for the Makefile to place on the host. ISSUER + audience(project id) for the
#    API; issuer + client id for the SPA. JWKS defaults to <issuer>/oauth/v2/keys (compose-reachable).
cat > /bootstrap/api.env.local <<ENV
# generated by infra/local/zitadel/provision.sh — gitignored, local dev only
OIDC_ISSUER=$BASE
OIDC_AUDIENCE=$PROJECT_ID
ENV

# 10) G2 SSO: append the bootstrap admin PAT as ZITADEL_MANAGEMENT_PAT so the api can provision
#     Zitadel orgs+IdPs in local dev. In prod the PAT is delivered as a credential FILE via Key Vault.
printf 'ZITADEL_MANAGEMENT_PAT=' >> /bootstrap/api.env.local
cat /bootstrap/admin.pat >> /bootstrap/api.env.local
printf '\n' >> /bootstrap/api.env.local
log "appended ZITADEL_MANAGEMENT_PAT to api.env.local"
cat > /bootstrap/web.env.local <<ENV
# generated by infra/local/zitadel/provision.sh — gitignored, local dev only
VITE_OIDC_ISSUER=$BASE
VITE_OIDC_CLIENT_ID=$CLIENT_ID
VITE_OIDC_REDIRECT_URI=$REDIRECT_URI
ENV

log "done. project=$PROJECT_ID client=$CLIENT_ID action=$ACTION_ID"

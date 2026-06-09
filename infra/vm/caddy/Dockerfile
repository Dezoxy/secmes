# syntax=docker/dockerfile:1
#
# argus production ingress image: builds the PWA (pnpm workspace) and serves it from Caddy, which also
# reverse-proxies /api + /ws to the API container. Build context is the REPO ROOT — the web build needs the
# pnpm workspace and @argus/crypto. Build from the repo root:
#   docker build -f infra/vm/caddy/Dockerfile -t argus-ingress .
# See infra/vm/caddy/Caddyfile and docs/threat-models/vm-ingress.md.

# ---- web build (pnpm workspace) ----
FROM node:26-alpine AS web-build
ENV CI=true
# Don't pull Playwright browsers during install (web's devDeps include @playwright/test; e2e isn't built here).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable
WORKDIR /repo
# Whole-repo copy (a root .dockerignore prunes node_modules/.git/dist) so every workspace manifest the
# lockfile references is present. Full install (not filtered): the root `prepare` lifecycle builds every
# `packages/*` on install (incl. @argus/contracts, which needs zod), so a filtered install would starve it.
COPY . .
RUN pnpm install --frozen-lockfile
# OIDC config is BUILD-TIME for the PWA: Vite only embeds `VITE_*` at build, and the client gates real auth
# on `VITE_OIDC_ISSUER` + `VITE_OIDC_CLIENT_ID` (else it runs in demo mode and sends no bearer token). Pass
# them as build args (compose.prod.yaml forwards them). Empty defaults until self-hosted Zitadel lands
# (roadmap #9) — wiring them now so a real build ships a real client, not a demo one.
ARG VITE_OIDC_ISSUER=""
ARG VITE_OIDC_CLIENT_ID=""
ARG VITE_OIDC_REDIRECT_URI=""
ENV VITE_OIDC_ISSUER=$VITE_OIDC_ISSUER \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID \
    VITE_OIDC_REDIRECT_URI=$VITE_OIDC_REDIRECT_URI
# `prepare` already built packages/*; build the PWA itself → apps/web/dist.
RUN pnpm --filter @argus/web build

# ---- runtime: Caddy serving the built PWA + proxying the API ----
FROM caddy:2-alpine AS runtime
COPY infra/vm/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /repo/apps/web/dist /srv
# Validate the config at build time (fail fast on a bad Caddyfile); create a non-root user; and STRIP the
# `cap_net_bind_service` file capability from the caddy binary. Without stripping it, a container started with
# `cap_drop: [ALL]` (as compose.prod.yaml does) cannot even exec caddy — the kernel refuses a binary that
# carries a file cap not in the bounding set. We bind :8080 (>1024), so the cap is never needed.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
 && apk add --no-cache libcap \
 && setcap -r /usr/bin/caddy \
 && apk del libcap \
 && addgroup -g 10001 caddyapp \
 && adduser -D -H -u 10001 -G caddyapp caddyapp \
 && chown -R caddyapp:caddyapp /data /config /srv
USER caddyapp
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:8080/caddy-healthz || exit 1

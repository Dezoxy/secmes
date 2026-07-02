# syntax=docker/dockerfile:1
#
# argus production ingress image: builds the PWA (pnpm workspace) and serves it from Caddy, which also
# reverse-proxies /api + /ws to the API container. Build context is the REPO ROOT — the web build needs the
# pnpm workspace and @argus/crypto. Build from the repo root:
#   docker build -f infra/stack/caddy/Dockerfile -t argus-ingress .
# See infra/stack/caddy/Caddyfile and docs/threat-models/vm-ingress.md.

# ---- web build (pnpm workspace) ----
FROM node:26-alpine AS web-build
ENV CI=true
# Don't pull Playwright browsers during install (web's devDeps include @playwright/test; e2e isn't built here).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# pnpm via npm, pinned to the repo's packageManager. corepack is unbundled in newer Node base images
# (node:26 has no corepack → `corepack enable` exits 127), so don't rely on it.
RUN npm install -g pnpm@11.9.0
WORKDIR /repo
# Whole-repo copy (a root .dockerignore prunes node_modules/.git/dist) so every workspace manifest the
# lockfile references is present. Full install (not filtered): the root `prepare` lifecycle builds every
# `packages/*` on install (incl. @argus/contracts, which needs zod), so a filtered install would starve it.
COPY . .
RUN pnpm install --frozen-lockfile
# Auth is passkey-only (Phase 6) — the PWA has no build-time OIDC config. `prepare` already built
# packages/*; build the PWA itself → apps/web/dist.
# VITE_APP_VERSION = the release tag (CD passes --build-arg from github.ref_name) so the About page version
# follows the release. The generated release-notes file is already in the context (CD regenerates it before
# this build; the committed copy is the fallback) — the build only consumes it. Unset → falls back to 0.0.0.
ARG VITE_APP_VERSION=
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ARG VITE_VAPID_PUBLIC_KEY=
ENV VITE_VAPID_PUBLIC_KEY=$VITE_VAPID_PUBLIC_KEY
RUN pnpm --filter @argus/web build

# ---- runtime: Caddy serving the built PWA + proxying the API ----
FROM caddy:2-alpine AS runtime
COPY infra/stack/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /repo/apps/web/dist /srv
# Validate the config at build time (fail fast on a bad Caddyfile); create a non-root user; and STRIP the
# `cap_net_bind_service` file capability from the caddy binary. Without stripping it, a container started with
# `cap_drop: [ALL]` (as compose.prod.yaml does) cannot even exec caddy — the kernel refuses a binary that
# carries a file cap not in the bounding set. We bind :8080 (>1024), so the cap is never needed.
RUN apk --no-cache upgrade \
 && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
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

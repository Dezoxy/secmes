# syntax=docker/dockerfile:1
#
# Workspace-aware build. The api depends on @argus/crypto via `workspace:*`, so it MUST build inside the pnpm
# workspace from the REPO ROOT (a self-contained `npm install` in apps/api fails: EUNSUPPORTEDPROTOCOL on the
# workspace: spec). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t argus-api .
# A root .dockerignore prunes node_modules/.git/secrets from the context.

# ---- build (full workspace) ----
FROM node:24-alpine AS build
ENV CI=true
# pnpm via npm, pinned to the repo's packageManager. corepack is unbundled in newer Node base images,
# so don't rely on `corepack enable` (keeps this stable across Node base-image bumps).
RUN npm install -g pnpm@9.12.0
WORKDIR /repo
COPY . .
# Install the whole workspace (the root `prepare` builds packages/* incl. @argus/crypto), then build the api
# → apps/api/dist (migration .sql files ride along via nest-cli `assets`).
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @argus/api build
# Produce a SELF-CONTAINED prod deployable at /app: prod deps only, with the workspace dep (@argus/crypto)
# hard-copied (not symlinked) so it survives the copy into the runtime stage.
RUN pnpm --filter @argus/api --prod deploy /app

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Patch OS CVEs, add the healthcheck wget, and DROP npm (+npx) from the runtime. The runtime only runs
# `node dist/main.js` and never needs a package manager; npm bundles its own (older) undici, which is the
# sole source of a HIGH CVE in the final image (our app's undici is current). Removing it fixes the CVE
# and shrinks the runtime / attack surface.
RUN apk --no-cache upgrade \
 && apk add --no-cache wget \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "dist/main.js"]

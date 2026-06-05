# Phase 0: self-contained build (context = apps/api).
# TODO (Phase 1+): switch to a repo-root build that wires in @secmes/contracts
# via pnpm workspace `--filter ... deploy`.

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN corepack enable && npm install --no-audit --no-fund
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# non-root, read-only-friendly
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "dist/main.js"]

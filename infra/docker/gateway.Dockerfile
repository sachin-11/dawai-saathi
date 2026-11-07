# syntax=docker/dockerfile:1.7
# Build from repo root:  docker build -f infra/docker/gateway.Dockerfile -t dawai/gateway .

ARG NODE_VERSION=20
ARG PNPM_VERSION=9.15.9

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo

# Manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@dawai/gateway..."

COPY apps/gateway apps/gateway
RUN pnpm --filter @dawai/gateway run build \
 && pnpm --filter @dawai/gateway deploy --prod --ignore-scripts /out

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Only dist/ + production node_modules (pnpm deploy honours "files").
COPY --from=build --chown=node:node /out ./

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]

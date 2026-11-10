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

# Prisma's engine needs OpenSSL to be detected correctly when the client is generated.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY apps/gateway apps/gateway
# M17: the admin pages show eval reports and the prompt list; the image cannot see evals/ at run time,
# so they are copied into apps/gateway/admin-data now (same script as `make admin-data`).
COPY evals/reports evals/reports
COPY apps/ai-service/app/prompts/files apps/ai-service/app/prompts/files
RUN node apps/gateway/scripts/sync-admin-data.mjs
# Install ran with --ignore-scripts, so generate the Prisma client explicitly (the build needs its types).
RUN pnpm --filter @dawai/gateway exec prisma generate \
 && pnpm --filter @dawai/gateway run build \
 && pnpm --filter @dawai/gateway deploy --prod --ignore-scripts /out
# `deploy` re-links production deps and drops the generated client, so generate it again inside /out
# (using the Prisma CLI from this stage; the CLI itself is a devDependency and is not shipped).
RUN cd /out && node /repo/apps/gateway/node_modules/prisma/build/index.js generate

# ---------------------------------------------------------------- migrate (M17, one-shot job)
# `prisma migrate deploy` needs the Prisma CLI, which is a devDependency and is not in the runtime image.
# This small target (CLI + schema + migrations only, not the whole build tree) is pushed as dawai/migrate and
# run by the `migrate` compose service before the new gateway starts.
FROM node:${NODE_VERSION}-bookworm-slim AS migrate
ARG PRISMA_VERSION=6.19.3
RUN apt-get update  && apt-get install -y --no-install-recommends openssl ca-certificates  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund --ignore-scripts prisma@${PRISMA_VERSION}  && node node_modules/prisma/build/index.js --version >/dev/null  && npm cache clean --force
COPY --from=build --chown=node:node /repo/apps/gateway/prisma ./prisma
ENV NODE_ENV=production
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/schema.prisma"]

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Prisma's query engine links against OpenSSL, which the slim image does not include.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# dist/, prisma/ (schema + migrations, for `prisma migrate deploy` jobs) + production node_modules
# (pnpm deploy honours "files").
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/apps/gateway/admin-data ./admin-data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]

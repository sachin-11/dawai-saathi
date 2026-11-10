# syntax=docker/dockerfile:1.7
# Build from repo root:
#   docker build -f infra/docker/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://dawai.rasuonline.in --build-arg NEXT_PUBLIC_WA_NUMBER=91XXXXXXXXXX \
#     -t dawai/web .
# NEXT_PUBLIC_* values are inlined into the bundle at BUILD time (they are public by design). Server-only
# values (GATEWAY_URL, DEMO_API_KEY, ADMIN_*, NEXTAUTH_*) are NEVER build args: they come from the
# environment when the container starts.

ARG NODE_VERSION=20
ARG PNPM_VERSION=9.15.9

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@dawai/web..."

COPY apps/web apps/web
# Inputs of scripts/prepare-build.mjs: eval numbers on the landing page and the architecture diagram.
COPY evals/reports evals/reports
COPY docs/architecture docs/architecture

ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_WA_NUMBER
ARG NEXT_PUBLIC_CONTACT_EMAIL
ARG NEXT_PUBLIC_GITHUB_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NODE_ENV=production \
    NEXT_STANDALONE=1 \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_WA_NUMBER=${NEXT_PUBLIC_WA_NUMBER} \
    NEXT_PUBLIC_CONTACT_EMAIL=${NEXT_PUBLIC_CONTACT_EMAIL} \
    NEXT_PUBLIC_GITHUB_URL=${NEXT_PUBLIC_GITHUB_URL} \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY}
RUN pnpm --filter @dawai/web run build \
 && pnpm --filter @dawai/web run scan:bundle

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output keeps the monorepo layout: server.js lives in apps/web/.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

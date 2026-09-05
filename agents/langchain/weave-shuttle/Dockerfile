# syntax=docker/dockerfile:1

# Weave Shuttle Agent Dockerfile
# 3-stage build: base (deps) → builder (compile) → production (run)
# Port: 8141

FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable \
    && npm install -g pnpm@10.34.5

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tooling ./tooling

# Copy only package.json files for stable dependency layer caching
COPY agents/langchain/weave-shuttle/package.json ./agents/langchain/weave-shuttle/

COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/agent-types/package.json ./packages/agent-types/
COPY packages/ai/package.json ./packages/ai/
COPY packages/database/package.json ./packages/database/
COPY packages/databricks/package.json ./packages/databricks/
COPY packages/logs/package.json ./packages/logs/
COPY packages/payments/package.json ./packages/payments/
COPY packages/rag/package.json ./packages/rag/
COPY packages/storage/package.json ./packages/storage/
COPY packages/utils/package.json ./packages/utils/
COPY packages/weave-core/package.json ./packages/weave-core/
COPY packages/observability/package.json ./packages/observability/
COPY packages/mail/package.json ./packages/mail/
COPY config/package.json ./config/

RUN pnpm install --frozen-lockfile --filter weave-shuttle...

FROM base AS builder
COPY packages ./packages
COPY config ./config
COPY agents/langchain/weave-shuttle ./agents/langchain/weave-shuttle

# Provide dummy DATABASE_URL for Prisma client generation
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN pnpm --filter @repo/database generate || true

# Bundle the agent with tsup
RUN pnpm --filter weave-shuttle build

FROM node:22-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable \
    && npm install -g pnpm@10.34.5

WORKDIR /app

# Copy workspace configuration for pnpm install
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/tooling ./tooling

# Copy package.json files for all workspace packages (needed for pnpm to resolve workspace deps)
COPY --from=builder /app/packages/agent-runtime/package.json ./packages/agent-runtime/
COPY --from=builder /app/packages/agent-types/package.json ./packages/agent-types/
COPY --from=builder /app/packages/ai/package.json ./packages/ai/
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/databricks/package.json ./packages/databricks/
COPY --from=builder /app/packages/observability ./packages/observability/
COPY --from=builder /app/packages/logs/package.json ./packages/logs/
COPY --from=builder /app/packages/payments/package.json ./packages/payments/
COPY --from=builder /app/packages/rag/package.json ./packages/rag/
COPY --from=builder /app/packages/storage/package.json ./packages/storage/
COPY --from=builder /app/packages/utils/package.json ./packages/utils/
COPY --from=builder /app/packages/weave-core/package.json ./packages/weave-core/
COPY --from=builder /app/packages/mail/package.json ./packages/mail/
COPY --from=builder /app/config/package.json ./config/
COPY --from=builder /app/agents/langchain/weave-shuttle/package.json ./agents/langchain/weave-shuttle/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile --filter weave-shuttle...

# Apache-2.0 §4(a) and §4(d): a recipient of the Work gets the licence and the
# NOTICE attributions. Publishing this image for someone else to pull is
# distribution, so they travel inside it. THIRD_PARTY_NOTICES.md comes too,
# because NOTICE points at it.
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./

# Copy built artifacts
COPY --from=builder /app/agents/langchain/weave-shuttle/dist ./agents/langchain/weave-shuttle/dist

ENV NODE_ENV=production
ENV PORT=8141

EXPOSE 8141

WORKDIR /app/agents/langchain/weave-shuttle

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8141/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run as a non-root user (SOC 2 CC7.1). Read-only runtime: serves HTTP on a
# high port (>1024) and writes nothing to the container filesystem, so the
# root-owned, world-readable app files need no chown (mirrors mcp-stdio-wrapper).
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs appuser
USER appuser

CMD ["node", "dist/index.js"]

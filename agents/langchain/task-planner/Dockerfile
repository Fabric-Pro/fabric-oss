# syntax=docker/dockerfile:1

# Task Planner Agent Dockerfile for Container Deployment
# Multi-stage build that packages the agent with its dependencies

# =============================================================================
# Stage 1: Base - Install dependencies
# =============================================================================
FROM node:22-slim AS base

# Install OpenSSL for Prisma and pnpm
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable \
    && npm install -g pnpm@11.28.2

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY tooling ./tooling

# Copy the agent package.json
COPY agents/langchain/task-planner/package.json ./agents/langchain/task-planner/

# Copy required workspace packages
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/agent-tools/package.json ./packages/agent-tools/
COPY packages/agent-types/package.json ./packages/agent-types/
COPY packages/ai/package.json ./packages/ai/
COPY packages/ai-token/package.json ./packages/ai-token/
COPY packages/database/package.json ./packages/database/
COPY packages/databricks/package.json ./packages/databricks/
COPY packages/utils/package.json ./packages/utils/
COPY packages/logs/package.json ./packages/logs/
COPY packages/mcp/package.json ./packages/mcp/
# @repo/mcp depends on @repo/integrations: its workspace manifest closure must be
# present for the filtered frozen install to register (not dangle) those packages.
COPY config/package.json ./config/
COPY packages/agent-prompts/package.json ./packages/agent-prompts/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/payments/package.json ./packages/payments/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/storage/package.json ./packages/storage/
COPY packages/rag/package.json ./packages/rag/
COPY packages/mail/package.json ./packages/mail/
COPY packages/observability/package.json ./packages/observability/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter task-planner-agent...

# =============================================================================
# Prisma client, generated from the schema alone
# =============================================================================
# Only the files `generate` reads are copied in, so this stage stays cached
# until the schema or the generate scripts change. After the full source copy
# it reran a five-minute generate on every change. tsconfig.json is one of
# those inputs: the generator takes the client's import extensions from it.
FROM base AS prisma
COPY packages/database/tsconfig.json ./packages/database/
COPY packages/database/prisma/schema.prisma packages/database/prisma/zod-generator.config.json packages/database/prisma/tsconfig.generated.json ./packages/database/prisma/
COPY packages/database/prisma/zod ./packages/database/prisma/zod
COPY packages/database/scripts/generate-client.mts packages/database/scripts/fix-zod-imports.ts ./packages/database/scripts/

# Provide dummy DATABASE_URL for Prisma client generation (agents are stateless and don't need DB)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
# `mkdir -p` leaves the builder's COPY a source when generate failed early.
RUN (pnpm --filter @repo/database generate || true) \
	&& mkdir -p packages/database/prisma/generated

# =============================================================================
# Stage 2: Build - Compile TypeScript
# =============================================================================
FROM base AS builder

COPY packages ./packages
COPY agents/langchain/task-planner ./agents/langchain/task-planner
COPY --from=prisma /app/packages/database/prisma/generated ./packages/database/prisma/generated
COPY --from=prisma /app/packages/database/prisma/zod ./packages/database/prisma/zod
RUN pnpm --filter task-planner-agent build

# =============================================================================
# Stage 3: Production - Minimal runtime image
# =============================================================================
FROM node:22-slim AS production

# Install OpenSSL and pnpm for production dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable \
    && npm install -g pnpm@11.28.2

WORKDIR /app

# Copy workspace configuration for pnpm install
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/patches ./patches
COPY --from=builder /app/tooling ./tooling

# Copy package.json files for all workspace packages
COPY --from=builder /app/packages/agent-core/package.json ./packages/agent-core/
COPY --from=builder /app/packages/agent-runtime/package.json ./packages/agent-runtime/
COPY --from=builder /app/packages/agent-tools/package.json ./packages/agent-tools/
COPY --from=builder /app/packages/agent-types/package.json ./packages/agent-types/
COPY --from=builder /app/packages/ai/package.json ./packages/ai/
COPY --from=builder /app/packages/ai-token/package.json ./packages/ai-token/
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/databricks/package.json ./packages/databricks/
COPY --from=builder /app/packages/utils/package.json ./packages/utils/
# Runtime observability imports these pure redaction helpers.
COPY --from=builder /app/packages/utils/lib/log-redaction.ts /app/packages/utils/lib/sensitive-keys.ts ./packages/utils/lib/
COPY --from=builder /app/packages/logs/package.json ./packages/logs/
COPY --from=builder /app/packages/mcp/package.json ./packages/mcp/
# @repo/mcp depends on @repo/integrations: its workspace manifest closure must be
# present for the filtered frozen install to register (not dangle) those packages.
COPY --from=builder /app/config/package.json ./config/
COPY --from=builder /app/packages/agent-prompts/package.json ./packages/agent-prompts/
COPY --from=builder /app/packages/integrations/package.json ./packages/integrations/
COPY --from=builder /app/packages/payments/package.json ./packages/payments/
COPY --from=builder /app/packages/permissions/package.json ./packages/permissions/
COPY --from=builder /app/packages/storage/package.json ./packages/storage/
COPY --from=builder /app/packages/rag/package.json ./packages/rag/
COPY --from=builder /app/packages/mail/package.json ./packages/mail/
# Observability is external (not bundled) - copy full source for runtime dynamic import
COPY --from=builder /app/packages/observability ./packages/observability/
COPY --from=builder /app/agents/langchain/task-planner/package.json ./agents/langchain/task-planner/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile --filter task-planner-agent...

# Apache-2.0 §4(a) and §4(d): a recipient of the Work gets the licence and the
# NOTICE attributions. Publishing this image for someone else to pull is
# distribution, so they travel inside it. THIRD_PARTY_NOTICES.md comes too,
# because NOTICE points at it.
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./

# Copy built artifacts
COPY --from=builder /app/agents/langchain/task-planner/dist ./agents/langchain/task-planner/dist

ENV NODE_ENV=production
ENV PORT=8126

EXPOSE 8126

WORKDIR /app/agents/langchain/task-planner

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8126/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run as a non-root user (SOC 2 CC7.1). Read-only runtime: serves HTTP on a
# high port (>1024) and writes nothing to the container filesystem, so the
# root-owned, world-readable app files need no chown (mirrors mcp-stdio-wrapper).
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs appuser
USER appuser

CMD ["node", "dist/unified-server.js"]


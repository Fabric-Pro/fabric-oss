# syntax=docker/dockerfile:1

# =============================================================================
# Fabric Web Application Dockerfile
# =============================================================================
# Optimized multi-stage build for Next.js with standalone output.
# Excludes agents, docs, and scripts directories for smaller image size.
# Updated: 2024-12-27 - Force cache refresh

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:22-slim AS deps

# Install OpenSSL for Prisma (required for libssl detection)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.34.5
WORKDIR /app

# Copy workspace configuration.
# .npmrc is REQUIRED: it carries public-hoist-pattern[]=*prisma* (and others) that
# hoist @prisma/client, @opentelemetry/*, etc. to the root node_modules. Without it
# pnpm's default strict isolation leaves @prisma/client unreachable from web (web
# doesn't declare it — it's @repo/database's dep), so `next build`'s type-check
# fails with "Cannot find module '@prisma/client/runtime/library'".
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tooling ./tooling

# Copy package.json files for workspace packages (excluding agents)
COPY apps/web/package.json ./apps/web/
COPY packages/ai/package.json ./packages/ai/
COPY packages/api/package.json ./packages/api/
COPY packages/atlas/package.json ./packages/atlas/
COPY packages/auth/package.json ./packages/auth/
COPY packages/database/package.json ./packages/database/
# @repo/database depends on @repo/databricks, so pnpm needs its manifest to
# build the workspace graph. Without it the link is never created and the web
# build fails compiling weave-core, where databricks/src/auth.ts cannot resolve
# its own @repo/logs import. Added to @repo/database by the Lakebase work; this
# Dockerfile was not updated then, and the image has not built since.
COPY packages/databricks/package.json ./packages/databricks/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/logs/package.json ./packages/logs/
COPY packages/mail/package.json ./packages/mail/
COPY packages/payments/package.json ./packages/payments/
COPY packages/storage/package.json ./packages/storage/
COPY packages/utils/package.json ./packages/utils/
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/agent-prompts/package.json ./packages/agent-prompts/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/agent-tools/package.json ./packages/agent-tools/
COPY packages/agent-types/package.json ./packages/agent-types/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/observability/package.json ./packages/observability/
COPY packages/openapi-tools/package.json ./packages/openapi-tools/
COPY packages/rag/package.json ./packages/rag/
COPY packages/letta/package.json ./packages/letta/
COPY packages/temporal/package.json ./packages/temporal/
COPY packages/editor-utils/package.json ./packages/editor-utils/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/ai-token/package.json ./packages/ai-token/
# Remaining workspace packages in web's (transitive) dependency closure. The
# hand-maintained list above was incomplete: web depends on @repo/code-validation,
# @repo/connectors, @repo/search, @repo/weave-core directly, and pulls in
# @repo/fabric-ai transitively. Without their package.json present, `pnpm install
# --filter web...` skips their deps and `next build` fails with "Module not found"
# when it transpiles their source (e.g. packages/fabric-ai imports @repo/logs/zod).
# Copying every packages/* manifest is harmless — the --filter only installs web's
# actual closure — and prevents this whole class of breakage when a new package is
# added to the closure.
COPY packages/cli/package.json ./packages/cli/
COPY packages/code-validation/package.json ./packages/code-validation/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/evidence/package.json ./packages/evidence/
COPY packages/fabric-ai/package.json ./packages/fabric-ai/
COPY packages/fabric-app/package.json ./packages/fabric-app/
COPY packages/integrations-github/package.json ./packages/integrations-github/
COPY packages/integrations-gmail/package.json ./packages/integrations-gmail/
COPY packages/integrations-linear/package.json ./packages/integrations-linear/
COPY packages/integrations-notion/package.json ./packages/integrations-notion/
COPY packages/integrations-runtime/package.json ./packages/integrations-runtime/
COPY packages/integrations-slack/package.json ./packages/integrations-slack/
COPY packages/mcp-registry/package.json ./packages/mcp-registry/
COPY packages/mcp-stdio-wrapper/package.json ./packages/mcp-stdio-wrapper/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/sandbox/package.json ./packages/sandbox/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk-mcp/package.json ./packages/sdk-mcp/
COPY packages/search/package.json ./packages/search/
COPY packages/weave-core/package.json ./packages/weave-core/
COPY config/package.json ./config/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter web...

# =============================================================================
# Stage 2: Build
# =============================================================================
FROM deps AS builder

# Copy all source code (excluding via .dockerignore)
COPY packages ./packages
COPY apps/web ./apps/web
COPY config ./config

# Create empty .env.local file for Next.js 16 (Turbopack requires it to exist)
RUN touch /app/apps/web/.env.local

# Provide dummy DATABASE_URL for Prisma client generation and Next.js build
# The actual DATABASE_URL will be provided at runtime via environment variables
ARG DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ARG DIRECT_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ARG NEXT_PUBLIC_SITE_URL="http://localhost:3000"

ENV DATABASE_URL=$DATABASE_URL
ENV DIRECT_URL=$DIRECT_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

# Generate Prisma client
RUN pnpm --filter @repo/database generate

# Build Next.js with standalone output.
# Use the `web...` filter (web AND its workspace dependencies) so pnpm builds the
# dependency packages first, in topological order, before web's `next build`.
# This is REQUIRED because several deps (e.g. @fabricorg/integrations-*) are
# build-output packages — their package.json `exports` point at ./dist/*, dist is
# gitignored (not in the CI checkout), and `next build` can't resolve them until
# their `tsup` build has produced dist. (Source-only packages like @repo/logs
# export raw .ts and are transpiled by Next directly, so they don't need this.)
ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_BUILD=true
# Split so the Next build gets a bigger heap than the shared `build` script
# grants. That script caps the old space at 6144 MB and Vercel runs it too, so
# raising it there risks trading a V8 heap error for the container OOM-killing
# the process. `web^...` is web's dependencies without web itself; web is then
# built directly with a cap sized for this runner.
#
# Needed because the build reaches further than it used to: it compiles fine
# ("Compiled successfully in 77s") and then exhausts the heap in the phase after,
# now that the workspace closure actually resolves.
RUN pnpm --filter "web^..." build
RUN cd apps/web && node --max-old-space-size=12288 ./node_modules/next/dist/bin/next build

# =============================================================================
# Stage 3: Production
# =============================================================================
FROM node:22-slim AS production

# Install OpenSSL for Prisma runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Don't run as root - ensure nextjs user is in nodejs group for proper file ownership
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nextjs

# Copy standalone build
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

# Apache-2.0 §4(a) and §4(d): a recipient of the Work gets the licence and the
# NOTICE attributions. Publishing this image for someone else to pull is
# distribution, so they travel inside it. THIRD_PARTY_NOTICES.md comes too,
# because NOTICE points at it.
COPY --chown=nextjs:nodejs LICENSE NOTICE THIRD_PARTY_NOTICES.md ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Expose port
EXPOSE 3000

# Switch to non-root user
USER nextjs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start server
CMD ["node", "apps/web/server.js"]


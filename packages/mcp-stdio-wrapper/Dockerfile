# =============================================================================
# MCP STDIO Wrapper Dockerfile
# =============================================================================
# Multi-stage build for the MCP STDIO Wrapper service.
# This service wraps STDIO-based MCP servers (like Azure DevOps) with an HTTP API.
#
# Features:
# - Runs as non-root user
# - Includes npm for dynamically installing MCP servers
# - Pre-installs common STDIO MCP servers
# =============================================================================

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:22-slim AS deps

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.json files for all workspace packages
COPY packages/mcp-stdio-wrapper/package.json packages/mcp-stdio-wrapper/
COPY packages/database/package.json packages/database/
COPY packages/utils/package.json packages/utils/
COPY tooling/typescript/package.json tooling/typescript/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:22-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy dependencies and workspace files
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/tooling ./tooling
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Copy source files
COPY packages/mcp-stdio-wrapper packages/mcp-stdio-wrapper
COPY packages/database packages/database
COPY packages/utils packages/utils
COPY tooling/typescript tooling/typescript

# Build (if needed - for now we run TypeScript directly with tsx)
# RUN pnpm --filter @repo/mcp-stdio-wrapper build

# =============================================================================
# Stage 3: Production
# =============================================================================
FROM node:22-slim AS production

# Install security updates
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Install pnpm for dynamic package installation
RUN corepack enable && corepack prepare pnpm@10 --activate

# Create non-root user with home directory. The uid/gid are pinned to a NUMERIC
# 1001 (SOC 2 CC7.1, card 1721 FR-7): Kubernetes can only verify runAsNonRoot
# against a numeric user, so an auto-assigned system uid would fail admission when
# the pod securityContext asserts non-root.
RUN groupadd -r -g 1001 mcpwrapper && useradd -r -u 1001 -g mcpwrapper -m -d /home/mcpwrapper mcpwrapper

WORKDIR /app

# Copy node_modules and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Apache-2.0 §4(a) and §4(d): a recipient of the Work gets the licence and the
# NOTICE attributions. Publishing this image for someone else to pull is
# distribution, so they travel inside it. THIRD_PARTY_NOTICES.md comes too,
# because NOTICE points at it.
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./

# Pre-install common STDIO MCP servers
# These will be available immediately without dynamic installation
#
# The Azure DevOps pin matches the catalog command seeded in
# `packages/database/prisma/seed.ts`: 2.9.0 consolidated the granular tool
# surface our PM call sites resolve by name, so both must move together.
RUN npm install -g \
    @azure-devops/mcp@2.8.0 \
    @modelcontextprotocol/server-github@latest \
    @playwright/mcp@0.0.76 \
    && npm cache clean --force

# Install Playwright OS dependencies (apt packages — must run before the USER
# switch below, while we are still root).
#
# The version specifier is load-bearing. A bare `npx playwright-core` fails here
# with exit 127 ("sh: 1: playwright-core: not found"), because:
#   - `playwright-core` IS present in the workspace node_modules copied from the
#     builder above (it is a transitive of the repo's Playwright dependency), so
#     npx resolves it locally and never fetches it;
#   - but pnpm's isolated layout only links DIRECT dependencies' bins into
#     node_modules/.bin, and playwright-core is transitive — so there is no
#     binary on PATH for npx to exec.
# Passing an explicit `playwright-core@<version>` forces npx to resolve from the
# registry instead of that unusable local copy.
#
# This is why it worked for months and then stopped: nothing here changed. The
# layer was cached, and the local resolution only starts biting once
# playwright-core appears in the copied node_modules. Reproduced both ways
# before changing it (old: 127, this: 0).
#
# Pinning to the version @playwright/mcp itself depends on also keeps the OS
# deps and the browser build below on one playwright-core, rather than letting
# this line drift independently.
RUN PW_VER=$(node -p "require('$(npm root -g)/@playwright/mcp/package.json').dependencies['playwright-core']") \
    && npx -y playwright-core@${PW_VER} install-deps chromium

# Create directory for dynamic MCP server installations
RUN mkdir -p /app/mcp-servers && chown mcpwrapper:mcpwrapper /app/mcp-servers

# Create npm cache directory in user's home (for npx -y dynamic installations)
RUN mkdir -p /home/mcpwrapper/.npm && chown -R mcpwrapper:mcpwrapper /home/mcpwrapper

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3100
ENV MAX_PROCESSES=50
ENV IDLE_TTL_MS=60000
# Ensure npm uses the user's home directory for caching
ENV HOME=/home/mcpwrapper
ENV NPM_CONFIG_CACHE=/home/mcpwrapper/.npm

# Expose port
EXPOSE 3100

# Switch to non-root user
USER mcpwrapper

# Install the Chromium build @playwright/mcp's own playwright-core expects
RUN PW_VER=$(node -p "require('$(npm root -g)/@playwright/mcp/package.json').dependencies['playwright-core']") \
    && npx -y playwright-core@${PW_VER} install chromium

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3100/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the server
CMD ["node", "--import", "tsx", "packages/mcp-stdio-wrapper/src/server.ts"]

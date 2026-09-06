# syntax=docker/dockerfile:1

# Temporal Worker Dockerfile for Container Deployment
# Multi-stage build that packages the worker with its dependencies

# =============================================================================
# Stage 1: Base - Install dependencies
# =============================================================================
FROM node:22-slim AS base

# Install OpenSSL for Prisma and pnpm
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.25.0

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tooling ./tooling

# Copy the temporal package.json
COPY packages/temporal/package.json ./packages/temporal/

# Copy required workspace packages
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/agent-prompts/package.json ./packages/agent-prompts/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/agent-tools/package.json ./packages/agent-tools/
COPY packages/agent-types/package.json ./packages/agent-types/
COPY packages/ai/package.json ./packages/ai/
COPY packages/ai-token/package.json ./packages/ai-token/
COPY packages/atlas/package.json ./packages/atlas/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/database/package.json ./packages/database/
COPY packages/databricks/package.json ./packages/databricks/
COPY packages/fabric-ai/package.json ./packages/fabric-ai/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/letta/package.json ./packages/letta/
COPY packages/logs/package.json ./packages/logs/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/mcp-registry/package.json ./packages/mcp-registry/
COPY packages/observability/package.json ./packages/observability/
COPY packages/openapi-tools/package.json ./packages/openapi-tools/
COPY packages/rag/package.json ./packages/rag/
COPY packages/search/package.json ./packages/search/
COPY packages/storage/package.json ./packages/storage/
COPY packages/utils/package.json ./packages/utils/
COPY packages/mail/package.json ./packages/mail/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/evidence/package.json ./packages/evidence/
COPY packages/payments/package.json ./packages/payments/
COPY packages/sandbox/package.json ./packages/sandbox/
COPY packages/weave-core/package.json ./packages/weave-core/

# Copy config package (dependency of storage)
COPY config/package.json ./config/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @repo/temporal...

# =============================================================================
# Stage 2: Build - Generate Prisma client and prepare
# =============================================================================
FROM base AS builder

# Copy all source code
COPY packages ./packages
COPY config ./config

# Provide dummy DATABASE_URL for Prisma client generation
# The actual DATABASE_URL will be provided at runtime via environment variables
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"

# Generate Prisma client. The `|| true` tolerates a transient generate failure
# (historic flake), but a STALE client shipping silently has caused real
# outages ("worker client missing newer columns") — so assert afterwards that
# the generated client actually contains a model this build's activities write
# (StoryPriorityChange, written by the AI-backlog apply path). A stale or
# missing client now fails the IMAGE BUILD instead of every apply at runtime.
RUN pnpm --filter @repo/database generate || true
RUN grep -rq "storyPriorityChange" packages/database/prisma/generated/ || \
	(echo "FATAL: generated Prisma client is missing StoryPriorityChange — prisma generate failed or shipped stale output" && exit 1)

# =============================================================================
# Stage 3: Production - Minimal runtime image
# =============================================================================
FROM node:22-slim AS production

# Install OpenSSL for Prisma runtime, git for code indexing clone, and other tools.
#
# python3 + pip + Semgrep are REQUIRED for the Security & Accessibility feature's
# Semgrep SAST code scan (runSemgrepScanActivity): the activity shells out to the
# `semgrep` binary to analyze a cloned repository for real code-level findings.
# Semgrep is a Python tool, so this pulls in the Python runtime and noticeably
# increases the image size (~hundreds of MB). The version is pinned to match the
# Semgrep CI workflow (.github/workflows/security.yml). Without it installed the
# activity degrades gracefully (logs skipped: "semgrep-unavailable") and the scan
# runs LLM-only — so this layer is what turns code findings on.
#
# gitleaks is the git-history secret scanner (runGitHistorySecretScanActivity):
# a single static Go binary fetched from the official release. Used with
# `gitleaks detect` over a full clone to catch secrets committed then removed.
# Absent ⇒ the activity logs skipped: "gitleaks-unavailable" (opt-in feature).
ARG GITLEAKS_VERSION=8.18.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    procps \
    git \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages semgrep==1.161.0 \
    && curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
        | tar -xz -C /usr/local/bin gitleaks \
    && chmod +x /usr/local/bin/gitleaks \
    && npm install -g pnpm@11.25.0 tsx@4.19.2

# Chromium + its shared libraries, for every activity that drives a browser.
#
# This image previously had NO browser binary at all. `playwright` is a
# dependency of @repo/temporal, but pnpm blocks its postinstall (it is absent
# from `allowBuilds` in pnpm-workspace.yaml), so the browsers were
# never downloaded — and node:22-slim lacks the shared libraries Chromium needs
# regardless. Anything calling `chromium.launch()` therefore failed at runtime
# with "Executable doesn't exist".
#
# Two shipped code paths were already affected and are fixed by this layer, not
# only the agentic test runner: `activities/frame-export/generate-pdf.ts` (frame
# PDF export) and `activities/browser-automation/session-manager.ts` (Weave
# browser steps).
#
# The install drives the workspace's OWN `playwright`, via the bin pnpm links
# for it. `playwright` is a DIRECT dependency of @repo/temporal, so that bin
# exists; transitive `playwright-core` gets no linked bin, which is why reaching
# for it here exits 127 ("sh: 1: playwright-core: not found").
#
# An earlier version of this layer copied `npx -y playwright-core@<pinned>` from
# `packages/mcp-stdio-wrapper/Dockerfile` on the theory that an explicit version
# forces npx to fetch from the registry rather than resolve the unusable local
# copy. It does not: npm exec treats a locally-installed package that satisfies
# the spec as already present, skips the fetch, then cannot exec a bin pnpm never
# linked. The wrapper only gets away with it because the version it asks for
# (@playwright/mcp's pinned playwright-core) differs from the one in the copied
# workspace tree, so the spec misses locally and the fetch does happen. Here the
# version is derived from the very package.json that produced the local install,
# so it always matches, and the fetch never happens. Exit 127, every build.
#
# Driving the linked bin also removes the version-skew class of bug outright: the
# browser build is downloaded by the same `playwright` the worker imports at
# runtime, so the revision it fetches is by construction the revision that
# library expects. A registry-pinned playwright-core can drift from the
# lockfile-resolved library and fail with exactly the "Executable doesn't exist"
# this layer exists to prevent.
#
# `install-deps` (apt packages) must run as root; it is here, before the USER
# switch below.
#
# PLAYWRIGHT_BROWSERS_PATH puts the browser in a shared, world-readable location
# instead of root's HOME — the worker runs as the unprivileged `appuser` created
# below and could not otherwise read it. This differs from the wrapper image,
# which installs into its runtime user's home; one shared copy is simpler here
# because only one user ever launches it.
#
# Cost: roughly 400 MB (a chromium build plus its apt dependencies) — estimated
# from the layer contents, not measured on a built image. Accepted on the same
# basis as the Semgrep layer above, which already trades hundreds of MB for a
# real capability.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Copy workspace configuration
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/tooling ./tooling
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

# Apache-2.0 §4(a) and §4(d): a recipient of the Work gets the licence and the
# NOTICE attributions. Publishing this image for someone else to pull is
# distribution, so they travel inside it. THIRD_PARTY_NOTICES.md comes too,
# because NOTICE points at it.
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY --from=builder /app/config ./config

# Installed AFTER the COPY steps, because the CLI it runs comes out of the copied
# node_modules — placing this earlier looks tidier and fails the build on a path
# that does not exist yet.
#
# The `node -e` line then launches the browser the LIBRARY resolves and asserts it
# runs, in the same spirit as the Prisma-client assertion above. Without it, the
# two failure modes this layer exists to prevent — no binary, or a binary whose
# revision the library rejects — stay invisible until a run fails in production.
RUN PW=/app/packages/temporal/node_modules/.bin/playwright \
    && "$PW" install-deps chromium \
    && "$PW" install chromium \
    && node -e "const {chromium}=require(require.resolve('playwright',{paths:['/app/packages/temporal']}));const p=chromium.executablePath();console.log('chromium at',p);require('child_process').execFileSync(p,['--version'],{stdio:'inherit'})" \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app/packages/temporal

# Run as a non-root, least-privilege user (SOC 2 CC7.1, card 1721 FR-7).
# The worker writes ONLY to the OS temp dir — git clones for code-indexing/Atlas
# (code-indexing.ts, atlas/service.ts) and the semgrep/gitleaks security scans all
# use os.tmpdir() => /tmp, which is world-writable + sticky — plus a writable HOME
# for tsx's transform cache and git's config, so the root-owned, world-readable app
# files need no chown. The numeric uid (1001, matching web + the agents) is what
# lets Kubernetes verify runAsNonRoot at admission (a named user cannot be verified).
# The home lives under /var/lib, not /home: the publication scan that guards the
# public relay rejects any path under /home as a developer home directory.
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs --home /var/lib/appuser appuser \
    && mkdir -p /var/lib/appuser \
    && chown appuser:nodejs /var/lib/appuser
ENV HOME=/var/lib/appuser
USER appuser

# Health check - verify the worker can start (simple check)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f "tsx.*worker" || exit 1

# Run the temporal worker
CMD ["tsx", "src/worker.ts"]

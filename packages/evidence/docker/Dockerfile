# Evidence.dev Builder Image
#
# This image is used to build Evidence projects into static HTML.
# It contains Node.js and the Evidence CLI pre-installed.
#
# Usage:
#   docker build -t fabric-evidence-builder .
#   docker run --rm -v /path/to/project:/evidence -v /path/to/output:/output fabric-evidence-builder
#
# Runs as root deliberately, and the caller controls the uid instead.
#
# Both /evidence and /output are bind mounts the caller creates and owns
# (see packages/evidence/src/builder/docker-builder.ts). On Linux a bind mount
# keeps its host ownership, so baking a fixed `USER` in here would make the
# container write as a uid that does not own those directories — `npm install`
# and `evidence build` would fail with EACCES for every caller whose uid is not
# the one we happened to pick. A build image that writes to caller-supplied
# mounts has to take its uid from the caller: `docker run --user "$(id -u)"`.
#
# This image is a local build tool. It is not deployed and not published: the
# Temporal activity that uses it falls back to a non-Docker build whenever
# Docker is unavailable, which is the case in Container Apps.

FROM node:22-alpine

# Set working directory
WORKDIR /evidence

# Install build dependencies
RUN apk add --no-cache git

# Pre-install Evidence to speed up builds
RUN npm install -g @evidence-dev/evidence@latest

# Set environment variables
ENV NODE_ENV=production
ENV EVIDENCE_OUTPUT_DIR=/output

# Default command: install deps and build
# Runs as root by design — see the note at the top of this file. The caller
# supplies the uid (`docker run --user "$(id -u)"`), because it owns the bind
# mounts this writes to.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["sh", "-c", "npm install --production=false && npx evidence build --output /output"]

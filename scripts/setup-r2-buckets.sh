#!/bin/bash
# ============================================================================
# Cloudflare R2 Bucket Setup Script
# ============================================================================
# Creates R2 buckets and configures CORS policies for browser uploads.
#
# Prerequisites:
#   - Wrangler CLI: npm install -g wrangler  (or:  pnpm dlx wrangler ...)
#   - Cloudflare authentication: wrangler login
#
# Usage:
#   ./scripts/setup-r2-buckets.sh [environment]
#
# Arguments:
#   environment - One of: prod, staging, dev (default: dev)
#
# Environment variables (optional):
#   CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID
#   CLOUDFLARE_API_TOKEN  - Cloudflare API token
#   STAGING_ORIGIN        - CORS origin allowed for the staging/dev buckets
#                           (default: a YOUR-STAGING-DOMAIN placeholder — set
#                           this to your actual staging host before running)
#
# ============================================================================
# WARNING — read before running, especially for the `staging` profile.
# ============================================================================
# As of the workspace-document-upload-failed-fetch fix (2026-05), the
# production app at https://fabric.pro was observed in DevTools to be
# issuing presigned PUTs to bucket name `workspace-documents` (the
# unprefixed name this script's `staging`/`dev` profiles target), NOT to
# `prod-workspace-documents` (the name the `prod` profile would create).
#
# This is runtime env-var drift: the production deployment's bucket-name
# config currently points at the unprefixed bucket, so production and
# staging are SHARING that bucket.
#
# Consequence: a production hotfix added `https://fabric.pro` to the
# CORS rule on the unprefixed `workspace-documents` bucket via a one-off
# manual `wrangler r2 bucket cors set` call. If you run THIS script with
# `staging` (or `dev`) without first updating the ORIGINS array below,
# you will OVERWRITE that rule and the production "Failed to fetch" bug
# will return immediately.
#
# Before running with `staging`:
#   1. Inspect the current CORS rule:
#        wrangler r2 bucket cors list workspace-documents
#   2. Confirm whether `https://fabric.pro` is in `AllowedOrigins`.
#   3. If yes, add `https://fabric.pro` to the `staging` ORIGINS array
#      below (or use a one-off `wrangler r2 bucket cors set` instead of
#      this script) so the script remains idempotent for production.
#
# The long-term fix is to migrate production onto the
# `prod-workspace-documents` bucket per the `prod` profile below; once
# that lands, this warning can be removed. Tracking:
# `infrastructure/storage/README.md` (Path A vs Path B).
# ============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Determine environment
ENV="${1:-dev}"

# CORS origin for the staging/dev buckets. Override with your own staging
# host; the placeholder below will not resolve to anything.
STAGING_ORIGIN="${STAGING_ORIGIN:-https://YOUR-STAGING-DOMAIN.example}"

# Set bucket names and CORS origins based on environment
if [[ "$ENV" == "prod" ]]; then
  BUCKETS=("prod-avatars" "prod-chat-documents" "prod-project-contexts" "prod-workspace-documents" "prod-orchestrator-artifacts")
  ORIGINS='["https://fabric.pro","https://www.fabric.pro"]'
elif [[ "$ENV" == "staging" ]]; then
  BUCKETS=("avatars" "chat-documents" "project-contexts" "workspace-documents" "orchestrator-artifacts")
  ORIGINS="[\"$STAGING_ORIGIN\"]"
else
  BUCKETS=("avatars" "chat-documents" "project-contexts" "workspace-documents" "orchestrator-artifacts")
  ORIGINS="[\"$STAGING_ORIGIN\",\"http://localhost:3000\",\"http://localhost:3001\"]"
fi

CORS_CONFIG="{\"rules\":[{\"allowed\":{\"origins\":$ORIGINS,\"methods\":[\"GET\",\"PUT\",\"POST\",\"DELETE\",\"HEAD\"],\"headers\":[\"*\"]},\"exposeHeaders\":[\"ETag\",\"Content-Length\",\"Content-Type\"],\"maxAgeSeconds\":3600}]}"

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Cloudflare R2 Bucket Setup${NC}"
echo -e "${GREEN}Environment: ${ENV}${NC}"
echo -e "${GREEN}============================================${NC}"

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
  echo -e "${RED}Error: wrangler CLI is not installed.${NC}"
  echo "Install it with: npm install -g wrangler"
  echo "Then authenticate with: wrangler login"
  exit 1
fi

# Create temporary CORS config file
CORS_FILE=$(mktemp)
echo "$CORS_CONFIG" > "$CORS_FILE"

# Create buckets and configure CORS
for BUCKET in "${BUCKETS[@]}"; do
  echo ""
  echo -e "${YELLOW}Processing bucket: ${BUCKET}${NC}"

  # Check if bucket exists
  if wrangler r2 bucket list 2>/dev/null | grep -q "\"$BUCKET\""; then
    echo -e "  ${GREEN}✓${NC} Bucket already exists"
  else
    echo -e "  Creating bucket..."
    if wrangler r2 bucket create "$BUCKET" 2>/dev/null; then
      echo -e "  ${GREEN}✓${NC} Bucket created"
    else
      echo -e "  ${YELLOW}⚠${NC} Bucket may already exist or creation failed"
    fi
  fi

  # Configure CORS
  echo -e "  Configuring CORS..."
  if wrangler r2 bucket cors set "$BUCKET" --file "$CORS_FILE" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} CORS configured"
  else
    echo -e "  ${RED}✗${NC} Failed to configure CORS"
  fi
done

# Cleanup
rm -f "$CORS_FILE"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Buckets configured:"
for BUCKET in "${BUCKETS[@]}"; do
  echo "  - $BUCKET"
done
echo ""
echo "CORS allows uploads from:"
for ORIGIN in $(echo "$ORIGINS" | tr -d '[]"' | tr ',' '\n'); do
  echo "  - $ORIGIN"
done
echo ""
if [[ "$ENV" == "prod" ]]; then
  echo -e "${YELLOW}Note:${NC} Make sure your .env has the correct bucket names:"
  echo "  NEXT_PUBLIC_AVATARS_BUCKET_NAME=\"prod-avatars\""
  echo "  NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME=\"prod-chat-documents\""
  echo "  NEXT_PUBLIC_PROJECT_CONTEXTS_BUCKET_NAME=\"prod-project-contexts\""
else
  echo -e "${YELLOW}Note:${NC} Make sure your .env has the correct bucket names:"
  echo "  NEXT_PUBLIC_AVATARS_BUCKET_NAME=\"avatars\""
  echo "  NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME=\"chat-documents\""
  echo "  NEXT_PUBLIC_PROJECT_CONTEXTS_BUCKET_NAME=\"project-contexts\""
fi

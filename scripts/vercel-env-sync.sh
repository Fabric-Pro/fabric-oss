#!/bin/bash
# =============================================================================
# Vercel Environment Variable Sync Script
# =============================================================================
# Syncs environment variables from .env files to Vercel project
#
# Usage:
#   ./scripts/vercel-env-sync.sh staging          # Sync staging env vars
#   ./scripts/vercel-env-sync.sh production       # Sync production env vars
#   ./scripts/vercel-env-sync.sh staging --dry-run # Preview without changes
#
# Prerequisites:
#   - Vercel CLI installed: npm i -g vercel
#   - Logged in: vercel login
#   - Project linked: vercel link
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
ENVIRONMENT="${1:-staging}"
DRY_RUN=false
if [[ "$2" == "--dry-run" ]]; then
    DRY_RUN=true
fi

# Map environment to Vercel target
case "$ENVIRONMENT" in
    staging|preview)
        VERCEL_TARGET="preview"
        ENV_FILE="$PROJECT_ROOT/.env.staging"
        ;;
    production|prod)
        VERCEL_TARGET="production"
        ENV_FILE="$PROJECT_ROOT/.env.production"
        ;;
    development|dev)
        VERCEL_TARGET="development"
        ENV_FILE="$PROJECT_ROOT/.env.local"
        ;;
    *)
        echo -e "${RED}Unknown environment: $ENVIRONMENT${NC}"
        echo "Usage: $0 [staging|production|development] [--dry-run]"
        exit 1
        ;;
esac

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}Vercel Environment Variable Sync${NC}"
echo -e "${BLUE}============================================${NC}"
echo -e "Environment: ${GREEN}$ENVIRONMENT${NC}"
echo -e "Vercel Target: ${GREEN}$VERCEL_TARGET${NC}"
echo -e "Source File: ${GREEN}$ENV_FILE${NC}"
echo -e "Dry Run: ${YELLOW}$DRY_RUN${NC}"
echo ""

# Check if env file exists
if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "${RED}Error: Environment file not found: $ENV_FILE${NC}"
    exit 1
fi

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo -e "${RED}Error: Vercel CLI not installed. Run: npm i -g vercel${NC}"
    exit 1
fi

# Variables to sync (critical for agent functionality)
VARS_TO_SYNC=(
    # Agent URLs
    "DOCUMENT_GENERATOR_URL"
    "PROJECT_DOCUMENT_GENERATOR_URL"
    "TASK_PLANNER_URL"
    "STORY_BREAKDOWN_URL"
    "API_AGENT_URL"
    "PROMPT_ENHANCER_URL"
    "CUGA_AGENT_URL"
    # Weave multi-agent orchestration (Pattern planner + readers + shuttle).
    # Required by the web app's weave/plans/create + revise-plan procedures,
    # which call Pattern directly via SecureA2AClient. Without WEAVE_PLANNERS_URL
    # the procedure falls back to http://localhost:8142 and silently fails on
    # Vercel with "fetch failed".
    "WEAVE_PLANNERS_URL"
    "WEAVE_READERS_URL"
    "WEAVE_SHUTTLE_URL"
    # Legacy references
    "AI_DOCUMENT_AGENT_URL"
    "DYNAMIC_AGENT_RUNTIME_URL"
    # Security
    "AI_TOKEN_SECRET"
    "AGENT_API_KEY"
    "AGENT_SERVICE_SECRET"
    "FABRIC_API_URL"
    "MCP_STDIO_WRAPPER_URL"
    "MCP_WRAPPER_API_KEY"
    # Database
    "DATABASE_URL"
    "DIRECT_URL"
    # Auth
    "BETTER_AUTH_SECRET"
    # Versioned encryption keys for at-rest secret columns (SOC 2 CC6.1 key
    # rotation). JSON { "<version>": "<secret>" }; source of truth is the
    # Key Vault secret `encryption-keys` (fabric-<suffix>-{dev,prod}-kv, where
    # the suffix is the ACR_SUFFIX repository variable). The web
    # tier must be able to decrypt k<version>-tagged ciphertext written by the
    # worker, so sync this BEFORE ENCRYPTION_ACTIVE_KEY_VERSION is ever set.
    # See your operator's key-rotation runbook.
    "ENCRYPTION_KEYS"
    "ENCRYPTION_ACTIVE_KEY_VERSION"
    # Vector DB
    "QDRANT_URL"
    "QDRANT_API_KEY"
    # Cache
    "UPSTASH_REDIS_REST_URL"
    "UPSTASH_REDIS_REST_TOKEN"
    # Temporal
    "TEMPORAL_ADDRESS"
    "TEMPORAL_NAMESPACE"
    "TEMPORAL_CLOUD_API_KEY"
    "ENABLE_TEMPORAL_WORKFLOWS"
    # Letta
    "LETTA_BASE_URL"
    "LETTA_API_KEY"
    # Cloudflare
    "CLOUDFLARE_ACCOUNT_ID"
    "CLOUDFLARE_API_TOKEN"
    # Collaboration
    "COLLAB_JWT_SECRET"
)

echo -e "${BLUE}Syncing ${#VARS_TO_SYNC[@]} variables...${NC}"
echo ""

# Read env file and sync variables
SYNCED=0
SKIPPED=0
FAILED=0

for VAR_NAME in "${VARS_TO_SYNC[@]}"; do
    # Extract value from env file (handle quotes and special chars)
    VAR_VALUE=$(grep "^${VAR_NAME}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | sed 's/^"//' | sed 's/"$//')
    
    if [[ -z "$VAR_VALUE" ]]; then
        echo -e "  ${YELLOW}⏭ $VAR_NAME${NC} - not set in env file, skipping"
        ((SKIPPED++))
        continue
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "  ${BLUE}🔍 $VAR_NAME${NC} = ${VAR_VALUE:0:30}..."
        ((SYNCED++))
    else
        # Add/update the variable in Vercel
        echo -n "  Setting $VAR_NAME... "
        if echo "$VAR_VALUE" | vercel env add "$VAR_NAME" "$VERCEL_TARGET" --force 2>/dev/null; then
            echo -e "${GREEN}✓${NC}"
            ((SYNCED++))
        else
            echo -e "${RED}✗${NC}"
            ((FAILED++))
        fi
    fi
done

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "Summary:"
echo -e "  ${GREEN}Synced: $SYNCED${NC}"
echo -e "  ${YELLOW}Skipped: $SKIPPED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo -e "${BLUE}============================================${NC}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo -e "${YELLOW}This was a dry run. Run without --dry-run to apply changes.${NC}"
fi

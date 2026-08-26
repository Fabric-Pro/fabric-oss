#!/bin/bash
# =============================================================================
# Configure Azure Key Vault Secrets for Fabric
# =============================================================================
# This script sets up all required secrets in Azure Key Vault for the
# Fabric application (Temporal worker and AI agents).
#
# AI API keys (OpenAI, Anthropic, etc.) are NOT stored here - they are
# fetched dynamically from the database via the token exchange API.
#
# Usage:
#   ./configure-keyvault-secrets.sh [environment] [--from-env <env-file>]
#
# Examples:
#   ./configure-keyvault-secrets.sh dev                          # Interactive mode
#   ./configure-keyvault-secrets.sh dev --from-env .env.local    # From env file
#   ./configure-keyvault-secrets.sh prod                         # Auto-detect .env.prod
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

ENV="${1:-dev}"
FROM_ENV=""
ENV_FILE=""

# Parse arguments
shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --from-env)
            FROM_ENV=true
            ENV_FILE="${2:-}"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Auto-detect env file if not specified
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -z "$ENV_FILE" ]]; then
    # Try to auto-detect .env.{environment} file
    if [[ -f "$PROJECT_ROOT/.env.${ENV}" ]]; then
        ENV_FILE="$PROJECT_ROOT/.env.${ENV}"
        FROM_ENV=true
        log_info "Auto-detected env file: $ENV_FILE"
    fi
fi

# Source env file if provided
if [[ "$FROM_ENV" == "true" && -n "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error "Env file not found: $ENV_FILE"
        exit 1
    fi
    log_info "Loading secrets from: $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
fi

# Find the Key Vault
log_info "Finding Key Vault for environment: ${ENV}..."
KV_NAME=$(az keyvault list --resource-group "fabric-${ENV}-rg" --query "[0].name" -o tsv)

if [[ -z "$KV_NAME" ]]; then
  log_error "No Key Vault found in fabric-${ENV}-rg"
  exit 1
fi

log_success "Using Key Vault: ${KV_NAME}"
echo ""

# Function to set a secret (prompts if not set via env var)
set_secret() {
  local name="$1"
  local env_var="$2"
  local description="$3"

  local value="${!env_var:-}"

  if [[ -z "$value" && "$FROM_ENV" != "true" ]]; then
    echo "Enter value for ${name} (${description}):"
    read -r value
  fi

  if [[ -n "$value" ]]; then
    az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" --output none
    log_success "Set secret: ${name}"
  else
    log_warn "Skipped: ${name} (no value provided)"
  fi
}

echo "=============================================="
echo "Required Secrets for Temporal Worker"
echo "=============================================="

# Database URL (required)
set_secret "database-url" "DATABASE_URL" "PostgreSQL connection string"

# Temporal configuration
set_secret "temporal-address" "TEMPORAL_ADDRESS" "Temporal server address"
set_secret "temporal-namespace" "TEMPORAL_NAMESPACE" "Temporal namespace"
set_secret "temporal-api-key" "TEMPORAL_CLOUD_API_KEY" "Temporal Cloud API key"

# Fabric API URL for callbacks
set_secret "fabric-api-url" "FABRIC_API_URL" "NextJS API URL (e.g., https://staging.fabric.pro)"

# Better Auth secret for AI Gateway key encryption
set_secret "better-auth-secret" "BETTER_AUTH_SECRET" "Better Auth encryption secret (same as Vercel)"

# Mail (Resend) — worker sends newsletter/notification emails
set_secret "resend-api-key" "RESEND_API_KEY" "Resend API key for worker-sent emails"

echo ""
echo "=============================================="
echo "RAG/Storage Secrets (Cloudflare R2)"
echo "=============================================="

set_secret "qdrant-url" "QDRANT_URL" "Qdrant server URL (e.g., https://xxx.us-east4-0.gcp.cloud.qdrant.io:6333)"
set_secret "qdrant-api-key" "QDRANT_API_KEY" "Qdrant API key"
set_secret "s3-endpoint" "S3_ENDPOINT" "Cloudflare R2 S3 endpoint (e.g., https://xxx.r2.cloudflarestorage.com)"
set_secret "s3-access-key-id" "S3_ACCESS_KEY_ID" "Cloudflare R2 access key ID"
set_secret "s3-secret-access-key" "S3_SECRET_ACCESS_KEY" "Cloudflare R2 secret access key"

echo ""
echo "=============================================="
echo "Agent Security Secrets"
echo "=============================================="
echo "(AI API keys are fetched dynamically from database)"

set_secret "agent-api-key" "AGENT_API_KEY" "Agent authentication API key"
set_secret "agent-service-secret" "AGENT_SERVICE_SECRET" "Inter-agent service secret"
set_secret "ai-token-secret" "AI_TOKEN_SECRET" "AI token signing secret (base64)"

echo ""
echo "=============================================="
echo "Fabric AI Server Security"
echo "=============================================="
echo "(API key authentication for Fabric AI Server)"

# These should be the SAME value - server validates, clients send
set_secret "fabric-server-api-key" "FABRIC_SERVER_API_KEY" "Fabric AI Server API key (server validates X-API-Key header)"
set_secret "fabric-ai-api-key" "FABRIC_AI_API_KEY" "Fabric AI API key (clients send in X-API-Key header)"

echo ""
echo "=============================================="
echo "Letta (Semantic Memory) Secrets"
echo "=============================================="

set_secret "letta-base-url" "LETTA_BASE_URL" "Letta API base URL (e.g., https://api.letta.com)"
set_secret "letta-api-key" "LETTA_API_KEY" "Letta API key"

echo ""
echo "=============================================="
echo "PartyKit (Real-time Collaboration) Secrets"
echo "=============================================="

set_secret "partykit-host" "NEXT_PUBLIC_PARTYKIT_HOST" "PartyKit host URL"
set_secret "collab-jwt-secret" "COLLAB_JWT_SECRET" "Collaboration JWT secret"

echo ""
echo "=============================================="
echo "Application Secrets"
echo "=============================================="

set_secret "better-auth-secret" "BETTER_AUTH_SECRET" "Better Auth secret for sessions"

echo ""
echo "=============================================="
echo "Agent URL Secrets (Auto-populated by CI/CD)"
echo "=============================================="
echo "(These are auto-generated after deployment. Set placeholder values for initial setup.)"

# Agent URL secrets - these are typically auto-populated by the CI/CD pipeline after
# agents are deployed. For manual setup, use placeholder values.
set_secret "document-generator-url" "DOCUMENT_GENERATOR_URL" "Document generator agent URL"
set_secret "project-document-generator-url" "PROJECT_DOCUMENT_GENERATOR_URL" "Project document generator agent URL"
set_secret "task-planner-url" "TASK_PLANNER_URL" "Task planner agent URL"
set_secret "story-breakdown-url" "STORY_BREAKDOWN_URL" "Story breakdown agent URL"
set_secret "api-agent-url" "API_AGENT_URL" "API agent URL"
set_secret "prompt-enhancer-url" "PROMPT_ENHANCER_URL" "Prompt enhancer agent URL"
set_secret "data-analyst-url" "DATA_ANALYST_URL" "Data analyst agent URL"
set_secret "fabric-ai-server-url" "FABRIC_AI_URL" "Fabric AI Server URL"
set_secret "mcp-stdio-wrapper-url" "MCP_STDIO_WRAPPER_URL" "MCP STDIO Wrapper URL"

echo ""
echo "=============================================="
echo "Weave Agent URL Secrets"
echo "=============================================="

set_secret "weave-readers-url" "WEAVE_READERS_URL" "Weave readers agent URL"
set_secret "weave-shuttle-url" "WEAVE_SHUTTLE_URL" "Weave shuttle agent URL"
set_secret "weave-planners-url" "WEAVE_PLANNERS_URL" "Weave planners agent URL"

echo ""
echo "=============================================="
echo "Fabric Internal (Shuttle Coding-Run Bridge)"
echo "=============================================="

# fabric-internal-secret removed — Shuttle now reuses AGENT_SERVICE_SECRET for bridge auth
set_secret "fabric-internal-url" "FABRIC_INTERNAL_URL" "Internal Fabric API URL for coding-run bridge"

echo ""
echo "=============================================="
echo "Background Agents (Coding Runs) Secrets"
echo "=============================================="

set_secret "background-agents-url" "BACKGROUND_AGENTS_URL" "Background agents URL"
set_secret "background-agents-internal-secret" "BACKGROUND_AGENTS_INTERNAL_SECRET" "Background agents internal auth secret"

echo ""
echo "=============================================="
echo "Sandbox Worker Secrets"
echo "=============================================="

set_secret "sandbox-worker-url" "SANDBOX_API_URL" "Sandbox worker URL"

echo ""
echo "=============================================="
echo "MCP STDIO Wrapper Secrets"
echo "=============================================="
# MCP STDIO Wrapper runs as a standalone container app with external ingress
# API key is required for authentication from Vercel web app and Temporal worker

set_secret "mcp-wrapper-api-key" "MCP_WRAPPER_API_KEY" "API key for MCP STDIO wrapper authentication"

echo ""
echo "=============================================="
echo "Redis (Real-time Streaming) Secrets"
echo "=============================================="

# Redis URL (for real-time execution streaming via Redis pub/sub)
set_secret "redis-url" "REDIS_URL" "Redis connection URL for real-time execution streaming (e.g., rediss://:key@host:6380)"

echo ""
echo "=============================================="
echo "Cloudflare Turnstile (CAPTCHA) Secrets"
echo "=============================================="

set_secret "turnstile-secret-key" "TURNSTILE_SECRET_KEY" "Cloudflare Turnstile secret key (server-side verification)"

echo ""
echo "=============================================="
echo "Configuration Complete!"
echo "=============================================="
echo ""
echo "To verify secrets, run:"
echo "  az keyvault secret list --vault-name ${KV_NAME} -o table"
echo ""
echo "Note: You may need to restart the Container Apps to pick up new secrets:"
echo "  az containerapp revision restart -g fabric-${ENV}-rg -n <app-name>"


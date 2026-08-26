#!/bin/bash
set -euo pipefail

# =============================================================================
# Azure Key Vault Secrets Configuration Script
# =============================================================================
# This script configures secrets in Azure Key Vault for the Fabric application
# Usage: ./configure-secrets.sh <environment> [--from-env <env-file>]
# Examples:
#   ./configure-secrets.sh dev                        # Interactive mode
#   ./configure-secrets.sh dev --from-env .env.local  # From env file
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

ENVIRONMENT="${1:-}"
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

if [ -z "$ENVIRONMENT" ]; then
    log_error "Usage: $0 <environment> [--from-env <env-file>]"
    exit 1
fi

# Configuration
KEY_VAULT_NAME="fabric-${ENVIRONMENT}-kv"

log_info "Configuring secrets for Key Vault: $KEY_VAULT_NAME"

# Required secrets mapping (env var name -> Key Vault secret name)
declare -A SECRETS=(
    ["DATABASE_URL"]="DATABASE-URL"
    ["DIRECT_URL"]="DIRECT-URL"
    ["BETTER_AUTH_SECRET"]="BETTER-AUTH-SECRET"
    ["OPENAI_API_KEY"]="OPENAI-API-KEY"
    ["ANTHROPIC_API_KEY"]="ANTHROPIC-API-KEY"
    ["GOOGLE_AI_API_KEY"]="GOOGLE-AI-API-KEY"
    ["STRIPE_SECRET_KEY"]="STRIPE-SECRET-KEY"
    ["STRIPE_WEBHOOK_SECRET"]="STRIPE-WEBHOOK-SECRET"
    ["AWS_ACCESS_KEY_ID"]="AWS-ACCESS-KEY-ID"
    ["AWS_SECRET_ACCESS_KEY"]="AWS-SECRET-ACCESS-KEY"
    ["TEMPORAL_ADDRESS"]="TEMPORAL-ADDRESS"
    ["TEMPORAL_NAMESPACE"]="TEMPORAL-NAMESPACE"
    ["TEMPORAL_CLOUD_API_KEY"]="TEMPORAL-API-KEY"
    ["REDIS_URL"]="REDIS-URL"
    ["NEXT_PUBLIC_SITE_URL"]="SITE-URL"
    ["FABRIC_API_URL"]="FABRIC-API-URL"
    # RAG/Storage secrets for Temporal Worker (Cloudflare R2)
    ["QDRANT_URL"]="QDRANT-URL"
    ["QDRANT_API_KEY"]="QDRANT-API-KEY"
    ["S3_ENDPOINT"]="S3-ENDPOINT"
    ["S3_ACCESS_KEY_ID"]="S3-ACCESS-KEY-ID"
    ["S3_SECRET_ACCESS_KEY"]="S3-SECRET-ACCESS-KEY"
)

# Optional secrets
declare -A OPTIONAL_SECRETS=(
    ["GITHUB_CLIENT_ID"]="GITHUB-CLIENT-ID"
    ["GITHUB_CLIENT_SECRET"]="GITHUB-CLIENT-SECRET"
    ["GOOGLE_CLIENT_ID"]="GOOGLE-CLIENT-ID"
    ["GOOGLE_CLIENT_SECRET"]="GOOGLE-CLIENT-SECRET"
    ["RESEND_API_KEY"]="RESEND-API-KEY"
    ["FIRECRAWL_API_KEY"]="FIRECRAWL-API-KEY"
)

set_secret() {
    local env_var=$1
    local secret_name=$2
    local value=$3
    
    if [ -n "$value" ]; then
        log_info "Setting secret: $secret_name"
        az keyvault secret set \
            --vault-name "$KEY_VAULT_NAME" \
            --name "$secret_name" \
            --value "$value" \
            --output none
        log_success "Set: $secret_name"
    else
        log_warn "Skipping $secret_name (no value provided)"
    fi
}

if [ "$FROM_ENV" = true ] && [ -n "$ENV_FILE" ]; then
    # Load from env file
    if [ ! -f "$ENV_FILE" ]; then
        log_error "Env file not found: $ENV_FILE"
        exit 1
    fi
    
    log_info "Loading secrets from: $ENV_FILE"
    
    # Source the env file safely
    set -a
    source "$ENV_FILE"
    set +a
    
    # Set required secrets
    for env_var in "${!SECRETS[@]}"; do
        secret_name="${SECRETS[$env_var]}"
        value="${!env_var:-}"
        set_secret "$env_var" "$secret_name" "$value"
    done
    
    # Set optional secrets
    for env_var in "${!OPTIONAL_SECRETS[@]}"; do
        secret_name="${OPTIONAL_SECRETS[$env_var]}"
        value="${!env_var:-}"
        if [ -n "$value" ]; then
            set_secret "$env_var" "$secret_name" "$value"
        fi
    done
else
    # Interactive mode
    log_info "Interactive mode - enter values for each secret (press Enter to skip)"
    echo ""
    
    for env_var in "${!SECRETS[@]}"; do
        secret_name="${SECRETS[$env_var]}"
        read -sp "Enter value for $env_var ($secret_name): " value
        echo ""
        set_secret "$env_var" "$secret_name" "$value"
    done
fi

echo ""
log_success "=============================================="
log_success "Secrets Configuration Complete!"
log_success "=============================================="

log_info "Configured secrets in Key Vault: $KEY_VAULT_NAME"
az keyvault secret list --vault-name "$KEY_VAULT_NAME" --query "[].name" -o table


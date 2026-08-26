#!/usr/bin/env bash
# =============================================================================
# Azure Key Vault Secrets Management
# =============================================================================
# This script manages secrets in Azure Key Vault for Fabric deployments.
# It reads secrets from environment variables and creates/updates them in Key Vault.
#
# Usage:
#   ./scripts/azure-keyvault-secrets.sh <environment> [options]
#
# Environment: dev, staging, prod
#
# Options:
#   --dry-run     Show what would be done without making changes
#   --force       Overwrite existing secrets
#   --verify      Only verify secrets exist, don't create
#
# Required Environment Variables:
#   - DATABASE_URL: PostgreSQL connection string
#   - TEMPORAL_ADDRESS: Temporal server address
#   - TEMPORAL_NAMESPACE: Temporal namespace
#   - TEMPORAL_CLOUD_API_KEY: Temporal API key (optional for local)
#   - FABRIC_API_URL: Fabric API URL
#
# RAG Environment Variables (optional):
#   - QDRANT_URL: Qdrant server URL
#   - QDRANT_API_KEY: Qdrant API key
#   - S3_ENDPOINT: Cloudflare R2 S3 endpoint
#   - S3_ACCESS_KEY_ID: Cloudflare R2 access key ID
#   - S3_SECRET_ACCESS_KEY: Cloudflare R2 secret access key
#
# =============================================================================

set -euo pipefail

# Source deploy utilities if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/deploy-utils.sh" ]; then
    source "$SCRIPT_DIR/deploy-utils.sh"
else
    # Minimal logging if deploy-utils.sh not available
    log_info() { echo "[INFO] $*"; }
    log_success() { echo "[SUCCESS] $*"; }
    log_warning() { echo "[WARNING] $*"; }
    log_error() { echo "[ERROR] $*"; }
    log_header() { echo "=== $* ==="; }
fi

# =============================================================================
# Configuration
# =============================================================================

ENVIRONMENT="${1:-}"
DRY_RUN=false
FORCE=false
VERIFY_ONLY=false

# Parse arguments
shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --verify)
            VERIFY_ONLY=true
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate environment
if [[ -z "$ENVIRONMENT" ]] || [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    log_error "Usage: $0 <environment> [--dry-run] [--force] [--verify]"
    log_error "Environment must be: dev, staging, or prod"
    exit 1
fi

# =============================================================================
# Secret Definitions
# =============================================================================

# Core secrets (required)
declare -A CORE_SECRETS=(
    ["database-url"]="${DATABASE_URL:-}"
    ["temporal-address"]="${TEMPORAL_ADDRESS:-}"
    ["temporal-namespace"]="${TEMPORAL_NAMESPACE:-}"
    ["temporal-api-key"]="${TEMPORAL_CLOUD_API_KEY:-}"
    ["fabric-api-url"]="${FABRIC_API_URL:-}"
)

# RAG/Storage secrets (optional)
declare -A RAG_SECRETS=(
    ["qdrant-url"]="${QDRANT_URL:-}"
    ["qdrant-api-key"]="${QDRANT_API_KEY:-}"
    ["s3-endpoint"]="${S3_ENDPOINT:-}"
    ["s3-access-key-id"]="${S3_ACCESS_KEY_ID:-}"
    ["s3-secret-access-key"]="${S3_SECRET_ACCESS_KEY:-}"
)

# =============================================================================
# Functions
# =============================================================================

get_keyvault_name() {
    local env=$1
    local rg="fabric-${env}-rg"
    
    # Try to get Key Vault name from Azure
    local kv_name
    kv_name=$(az keyvault list --resource-group "$rg" --query "[0].name" -o tsv 2>/dev/null || echo "")
    
    if [[ -z "$kv_name" || "$kv_name" == "null" ]]; then
        log_error "Could not find Key Vault in resource group $rg"
        log_error "Make sure the infrastructure is deployed first."
        exit 1
    fi
    
    echo "$kv_name"
}

secret_exists() {
    local kv_name=$1
    local secret_name=$2
    
    az keyvault secret show --vault-name "$kv_name" --name "$secret_name" &>/dev/null
}

set_secret() {
    local kv_name=$1
    local secret_name=$2
    local secret_value=$3
    
    if [[ -z "$secret_value" ]]; then
        log_warning "Skipping $secret_name (no value provided)"
        return 0
    fi
    
    if $DRY_RUN; then
        log_info "[DRY-RUN] Would set secret: $secret_name"
        return 0
    fi
    
    if secret_exists "$kv_name" "$secret_name" && ! $FORCE; then
        log_info "Secret $secret_name already exists (use --force to overwrite)"
        return 0
    fi
    
    if az keyvault secret set \
        --vault-name "$kv_name" \
        --name "$secret_name" \
        --value "$secret_value" \
        --output none 2>/dev/null; then
        log_success "Set secret: $secret_name"
    else
        log_error "Failed to set secret: $secret_name"
        return 1
    fi
}

verify_secret() {
    local kv_name=$1
    local secret_name=$2
    local required=$3
    
    if secret_exists "$kv_name" "$secret_name"; then
        log_success "✓ $secret_name exists"
        return 0
    else
        if [[ "$required" == "true" ]]; then
            log_error "✗ $secret_name is MISSING (required)"
            return 1
        else
            log_warning "✗ $secret_name is missing (optional)"
            return 0
        fi
    fi
}

# =============================================================================
# Main
# =============================================================================

log_header "Azure Key Vault Secrets Management"
log_info "Environment: $ENVIRONMENT"
log_info "Dry Run: $DRY_RUN"
log_info "Force: $FORCE"
log_info "Verify Only: $VERIFY_ONLY"
echo ""

# Check Azure CLI is logged in
if ! az account show &>/dev/null; then
    log_error "Not logged in to Azure CLI. Run 'az login' first."
    exit 1
fi

# Get Key Vault name
log_info "Finding Key Vault..."
KV_NAME=$(get_keyvault_name "$ENVIRONMENT")
log_success "Found Key Vault: $KV_NAME"
echo ""

if $VERIFY_ONLY; then
    # Verify mode - just check if secrets exist
    log_header "Verifying Secrets"
    
    errors=0
    
    log_info "Core Secrets:"
    for secret_name in "${!CORE_SECRETS[@]}"; do
        verify_secret "$KV_NAME" "$secret_name" "true" || ((errors++))
    done
    
    echo ""
    log_info "RAG/Storage Secrets:"
    for secret_name in "${!RAG_SECRETS[@]}"; do
        verify_secret "$KV_NAME" "$secret_name" "false" || true
    done
    
    echo ""
    if [[ $errors -gt 0 ]]; then
        log_error "$errors required secret(s) missing"
        exit 1
    else
        log_success "All required secrets present"
    fi
else
    # Set secrets mode
    log_header "Setting Core Secrets"
    
    for secret_name in "${!CORE_SECRETS[@]}"; do
        set_secret "$KV_NAME" "$secret_name" "${CORE_SECRETS[$secret_name]}"
    done
    
    echo ""
    log_header "Setting RAG/Storage Secrets"
    
    for secret_name in "${!RAG_SECRETS[@]}"; do
        set_secret "$KV_NAME" "$secret_name" "${RAG_SECRETS[$secret_name]}"
    done
    
    echo ""
    log_success "Secret management complete!"
fi


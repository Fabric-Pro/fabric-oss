#!/bin/bash
set -euo pipefail

# =============================================================================
# Update Container Apps with New Images
# =============================================================================
# This script updates Azure Container Apps with images from ACR
# Usage: ./update-containers.sh <environment> [service]
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
TARGET_SERVICE="${2:-}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

if [ -z "$ENVIRONMENT" ]; then
    log_error "Usage: $0 <environment> [service]"
    exit 1
fi

RESOURCE_GROUP="fabric-${ENVIRONMENT}-rg"
ACR_NAME=$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null)
ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"

log_info "Environment: $ENVIRONMENT"
log_info "Resource Group: $RESOURCE_GROUP"
log_info "ACR: $ACR_LOGIN_SERVER"

# Map service names to container app names
declare -A SERVICE_TO_APP=(
    ["cuga"]="fabric-${ENVIRONMENT}-cuga"
    ["temporal-worker"]="fabric-${ENVIRONMENT}-temporal-worker"
    ["doc-gen"]="fabric-${ENVIRONMENT}-doc-gen"
    ["task-planner"]="fabric-${ENVIRONMENT}-task-planner"
    ["story-breakdown"]="fabric-${ENVIRONMENT}-story-breakdown"
    ["api-agent"]="fabric-${ENVIRONMENT}-api-agent"
    ["prompt-enhancer"]="fabric-${ENVIRONMENT}-prompt-enhancer"
    ["project-doc-gen"]="fabric-${ENVIRONMENT}-project-doc-gen"
)

update_container() {
    local service=$1
    local app_name="${SERVICE_TO_APP[$service]}"
    local image="${ACR_LOGIN_SERVER}/${service}:${IMAGE_TAG}"
    
    log_info "Updating $app_name with image $image..."
    
    # Check if container app exists
    if ! az containerapp show --name "$app_name" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
        log_warn "Container App $app_name not found - skipping"
        return 0
    fi
    
    # Update the container image
    az containerapp update \
        --name "$app_name" \
        --resource-group "$RESOURCE_GROUP" \
        --image "$image" \
        --output none
    
    log_success "Updated: $app_name"
}

if [ -n "$TARGET_SERVICE" ]; then
    if [ -z "${SERVICE_TO_APP[$TARGET_SERVICE]:-}" ]; then
        log_error "Unknown service: $TARGET_SERVICE"
        exit 1
    fi
    update_container "$TARGET_SERVICE"
else
    log_info "Updating all container apps..."
    for service in "${!SERVICE_TO_APP[@]}"; do
        update_container "$service"
    done
fi

echo ""
log_success "=============================================="
log_success "Container Update Complete!"
log_success "=============================================="

# Show container app status
log_info "Container App Status:"
az containerapp list --resource-group "$RESOURCE_GROUP" \
    --query "[].{Name:name,Status:properties.runningStatus,Image:properties.template.containers[0].image}" \
    -o table


#!/bin/bash
set -euo pipefail

# =============================================================================
# Azure Container Registry Build and Push Script
# =============================================================================
# This script builds Docker images and pushes them to Azure Container Registry
# Usage: ./build-and-push.sh <environment> [service]
# Examples:
#   ./build-and-push.sh dev          # Build and push all services
#   ./build-and-push.sh dev cuga     # Build and push only cuga
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check arguments
ENVIRONMENT="${1:-}"
TARGET_SERVICE="${2:-}"

if [ -z "$ENVIRONMENT" ]; then
    log_error "Usage: $0 <environment> [service]"
    log_info "Environments: dev, prod"
    log_info "Services: cuga, temporal-worker, document-generator, task-planner, story-breakdown, api-agent, prompt-enhancer, project-document-generator"
    exit 1
fi

# Configuration
RESOURCE_GROUP="fabric-${ENVIRONMENT}-rg"
ACR_NAME=$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null)

if [ -z "$ACR_NAME" ]; then
    log_error "No Container Registry found in resource group $RESOURCE_GROUP"
    exit 1
fi

ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
IMAGE_TAG="${IMAGE_TAG:-latest}"

log_info "Environment: $ENVIRONMENT"
log_info "ACR: $ACR_LOGIN_SERVER"
log_info "Image Tag: $IMAGE_TAG"

# Login to ACR
log_info "Logging into Azure Container Registry..."
az acr login --name "$ACR_NAME"

# Define services and their Dockerfiles
# NOTE: Image names must match what's expected in main.bicep (imageName field)
# The Bicep template uses full image names from ACR (e.g., fabric/document-generator)
declare -A SERVICES=(
    ["temporal-worker"]="packages/temporal/Dockerfile"
    ["document-generator"]="agents/langchain/document-generator/Dockerfile"
    ["task-planner"]="agents/langchain/task-planner/Dockerfile"
    ["story-breakdown"]="agents/langchain/story-breakdown/Dockerfile"
    ["api-agent"]="agents/langchain/api-agent/Dockerfile"
    ["prompt-enhancer"]="agents/langchain/prompt-enhancer/Dockerfile"
    ["project-document-generator"]="agents/langchain/project-document-generator/Dockerfile"
    ["weave-readers"]="agents/langchain/weave-readers/Dockerfile"
    ["weave-shuttle"]="agents/langchain/weave-shuttle/Dockerfile"
    ["weave-planners"]="agents/langchain/weave-planners/Dockerfile"
)

# Build and push function
build_and_push() {
    local service=$1
    local dockerfile=$2
    # Image path must match what Bicep expects: fabric/<service-name>
    local image_name="${ACR_LOGIN_SERVER}/fabric/${service}:${IMAGE_TAG}"
    
    log_info "Building $service..."
    
    if [ ! -f "$PROJECT_ROOT/$dockerfile" ]; then
        log_warn "Dockerfile not found: $dockerfile - skipping $service"
        return 0
    fi
    
    # Determine build context - CUGA uses its own directory as context
    local build_context="$PROJECT_ROOT"
    if [ "$service" = "cuga" ]; then
        build_context="$PROJECT_ROOT/agents/langchain/cuga"
    fi
    
    # Build the image
    docker build \
        -t "$image_name" \
        -f "$PROJECT_ROOT/$dockerfile" \
        --build-arg ENVIRONMENT="$ENVIRONMENT" \
        "$build_context"
    
    log_info "Pushing $service to ACR..."
    docker push "$image_name"
    
    log_success "$service pushed successfully: $image_name"
}

# Build services
cd "$PROJECT_ROOT"

if [ -n "$TARGET_SERVICE" ]; then
    # Build single service
    if [ -z "${SERVICES[$TARGET_SERVICE]:-}" ]; then
        log_error "Unknown service: $TARGET_SERVICE"
        log_info "Available services: ${!SERVICES[*]}"
        exit 1
    fi
    build_and_push "$TARGET_SERVICE" "${SERVICES[$TARGET_SERVICE]}"
else
    # Build all services
    log_info "Building all services..."
    for service in "${!SERVICES[@]}"; do
        build_and_push "$service" "${SERVICES[$service]}"
    done
fi

echo ""
log_success "=============================================="
log_success "Build and Push Complete!"
log_success "=============================================="

# Show pushed images
log_info "Pushed images:"
az acr repository list --name "$ACR_NAME" -o table


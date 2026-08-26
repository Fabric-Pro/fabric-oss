#!/bin/bash
# =============================================================================
# Azure Container Apps Deployment Script
# =============================================================================
# Deploys Fabric Temporal Workers and LangGraph Agents to Azure Container Apps
#
# Prerequisites:
#   - Azure CLI installed and logged in
#   - Docker installed
#   - Bicep CLI installed (az bicep install)
#
# Usage:
#   ./deploy.sh [environment] [--skip-build] [unique-suffix]
#
# Examples:
#   ./deploy.sh dev                    # Deploy to dev environment
#   ./deploy.sh dev --skip-build       # Deploy to dev, skip image builds
#   ./deploy.sh prod "" mycompany      # Deploy to prod with custom suffix
# =============================================================================

set -euo pipefail

# Configuration
ENVIRONMENT="${1:-dev}"
SKIP_BUILD="${2:-}"
# Unique suffix for globally unique Azure resource names (ACR, Key Vault)
# If not provided, generate one from subscription ID
UNIQUE_SUFFIX="${3:-}"
LOCATION="eastus"
BASE_NAME="fabric"

# Generate unique suffix if not provided
if [[ -z "${UNIQUE_SUFFIX}" ]]; then
  # Get subscription ID and create a short hash from it
  SUB_ID=$(az account show --query id -o tsv 2>/dev/null || echo "default")
  UNIQUE_SUFFIX=$(echo "${SUB_ID}" | md5sum | cut -c1-6)
  echo "Generated unique suffix: ${UNIQUE_SUFFIX}"
fi

RESOURCE_GROUP="${BASE_NAME}-${ENVIRONMENT}-rg"
# ACR names must be globally unique and alphanumeric only (no hyphens)
ACR_NAME="${BASE_NAME}${UNIQUE_SUFFIX}${ENVIRONMENT}acr"
IMAGE_TAG="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
# Lakebase / Databricks database auth (see docs/deployment/DATABRICKS.md).
# Must match the values the GitHub deploy workflows pass — otherwise a manual
# run silently rolls the worker and weave-planners back to the Bicep defaults.
DATABASE_AUTH_PROVIDER="${DATABASE_AUTH_PROVIDER:-password}"
WORKER_RLS_MODE="${WORKER_RLS_MODE:-bypassrls}"

echo "=============================================="
echo "Azure Container Apps Deployment"
echo "=============================================="
echo "Environment: ${ENVIRONMENT}"
echo "Resource Group: ${RESOURCE_GROUP}"
echo "ACR Name: ${ACR_NAME}"
echo "Image Tag: ${IMAGE_TAG}"
echo "=============================================="

# Ensure logged in
echo "Checking Azure CLI login..."
az account show > /dev/null 2>&1 || { echo "Please login with 'az login'"; exit 1; }

# Create resource group
echo "Creating resource group..."
az group create --name "${RESOURCE_GROUP}" --location "${LOCATION}" --output none

# Create ACR if not exists
echo "Ensuring Container Registry exists..."
az acr show --name "${ACR_NAME}" > /dev/null 2>&1 || \
  az acr create --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --sku Basic --admin-enabled true

# Login to ACR
echo "Logging into Container Registry..."
az acr login --name "${ACR_NAME}"

ACR_SERVER="${ACR_NAME}.azurecr.io"

# Build and push images (unless skipped)
if [[ "${SKIP_BUILD}" != "--skip-build" ]]; then
  echo ""
  echo "Building container images..."
  
  # Build Temporal Worker
  echo "Building Temporal Worker..."
  docker build -t "${ACR_SERVER}/fabric/temporal-worker:${IMAGE_TAG}" \
    -t "${ACR_SERVER}/fabric/temporal-worker:latest" \
    -f packages/temporal/Dockerfile .
  docker push "${ACR_SERVER}/fabric/temporal-worker:${IMAGE_TAG}"
  docker push "${ACR_SERVER}/fabric/temporal-worker:latest"
  
  # Build LangGraph agents
  LANGCHAIN_AGENTS=("document-generator" "task-planner" "story-breakdown" "api-agent" "prompt-enhancer" "project-document-generator")
  for agent in "${LANGCHAIN_AGENTS[@]}"; do
    echo "Building ${agent}..."
    docker build -t "${ACR_SERVER}/fabric/${agent}:${IMAGE_TAG}" \
      -t "${ACR_SERVER}/fabric/${agent}:latest" \
      -f "agents/langchain/${agent}/Dockerfile" .
    docker push "${ACR_SERVER}/fabric/${agent}:${IMAGE_TAG}"
    docker push "${ACR_SERVER}/fabric/${agent}:latest"
  done
  
  # Build CUGA Python agent (build context is the cuga directory itself)
  echo "Building CUGA agent..."
  docker build -t "${ACR_SERVER}/fabric/cuga:${IMAGE_TAG}" \
    -t "${ACR_SERVER}/fabric/cuga:latest" \
    -f "agents/langchain/cuga/Dockerfile" "agents/langchain/cuga"
  docker push "${ACR_SERVER}/fabric/cuga:${IMAGE_TAG}"
  docker push "${ACR_SERVER}/fabric/cuga:latest"
fi

# Bootstrap worker-database-url in Key Vault
# main.bicep references the worker-database-url Key Vault secret for the
# temporal-worker / weave-planners Container Apps. A manual redeploy of an
# existing installation via this script never created that secret, so the
# bicep deployment below would fail on an unresolvable secret reference.
# Seed it from database-url (or WORKER_DATABASE_URL/DATABASE_URL env vars)
# before deploying. A missing Key Vault degrades to a warning, not a hard
# failure — main.bicep creates the vault itself on a brand-new environment.
echo ""
echo "Ensuring worker-database-url secret exists in Key Vault..."
KV_NAME="${BASE_NAME}-${UNIQUE_SUFFIX:0:4}-${ENVIRONMENT}-kv"
if az keyvault show --name "${KV_NAME}" > /dev/null 2>&1; then
  CURRENT_WORKER_DB=$(az keyvault secret show --vault-name "${KV_NAME}" --name worker-database-url --query value -o tsv 2>/dev/null || true)
  if [[ -z "${CURRENT_WORKER_DB}" || "${CURRENT_WORKER_DB}" == "placeholder" ]]; then
    WORKER_DB_SEED="${WORKER_DATABASE_URL:-${DATABASE_URL:-}}"
    if [[ -z "${WORKER_DB_SEED}" ]]; then
      WORKER_DB_SEED=$(az keyvault secret show --vault-name "${KV_NAME}" --name database-url --query value -o tsv 2>/dev/null || true)
    fi
    if [[ -n "${WORKER_DB_SEED}" ]]; then
      echo "Seeding worker-database-url from fallback chain"
      az keyvault secret set --vault-name "${KV_NAME}" --name worker-database-url --value "${WORKER_DB_SEED}" --output none
    else
      echo "No database-url value available yet — creating worker-database-url as placeholder"
      az keyvault secret set --vault-name "${KV_NAME}" --name worker-database-url --value "placeholder" --output none
    fi
  else
    echo "Secret exists: worker-database-url"
  fi
else
  echo "WARNING: Key Vault ${KV_NAME} not found — skipping worker-database-url bootstrap (main.bicep will create the vault; re-run this script afterward if the deployment fails on the secret reference)."
fi

# Deploy Bicep template
echo ""
echo "Deploying Azure infrastructure..."
az deployment group create \
  --resource-group "${RESOURCE_GROUP}" \
  --template-file "deployment/azure/main.bicep" \
  --parameters "envName=${ENVIRONMENT}" "imageTag=${IMAGE_TAG}" "uniqueSuffix=${UNIQUE_SUFFIX}" \
    "databaseAuthProvider=${DATABASE_AUTH_PROVIDER}" "workerRlsMode=${WORKER_RLS_MODE}" \
  --output table

echo ""
echo "=============================================="
echo "Deployment Complete!"
echo "=============================================="

# Get outputs
echo ""
echo "Container App URLs:"
az containerapp list --resource-group "${RESOURCE_GROUP}" \
  --query "[].{Name:name, URL:properties.configuration.ingress.fqdn}" \
  --output table

echo ""
echo "Next steps:"
echo "1. Add secrets to Key Vault: ${BASE_NAME}-${ENVIRONMENT}-kv"
echo "2. Configure environment variables in Container Apps"
echo "3. Verify health endpoints"


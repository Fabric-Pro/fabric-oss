# Azure Container Apps Deployment

This directory contains the infrastructure-as-code and deployment configurations for deploying Fabric's Temporal Workers and LangGraph Agents to Azure Container Apps.

> Resource names below (`<resource-group>`, `<key-vault>`, `<registry>`, `<container-app-env>`, `<log-analytics-workspace>`) are placeholders — substitute your own environment's names wherever they appear.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Azure Container Apps                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Container Apps Environment                                     │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                          │   │
│   │  ┌──────────────────┐  ┌──────────────────────────────┐│   │
│   │  │ Temporal Worker  │  │     LangGraph Agents         ││   │
│   │  │ ┌──────────────┐ │  │ ┌────────┐ ┌────────┐       ││   │
│   │  │ │ ai-chat      │ │  │ │doc-gen │ │task-   │ ...   ││   │
│   │  │ │ doc-process  │ │  │ │        │ │planner │       ││   │
│   │  │ │ workflow-bldr│ │  │ └────────┘ └────────┘       ││   │
│   │  │ └──────────────┘ │  │                              ││   │
│   │  └──────────────────┘  └──────────────────────────────┘│   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│   ┌──────────────────────────┴───────────────────────────────┐  │
│   │                    Supporting Services                    │  │
│   │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │  │
│   │  │ Container  │  │  Key Vault │  │  Log Analytics     │ │  │
│   │  │ Registry   │  │  (Secrets) │  │  (Monitoring)      │ │  │
│   │  └────────────┘  └────────────┘  └────────────────────┘ │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ Temporal │        │  Neon    │        │  Qdrant  │
   │  Cloud   │        │ Postgres │        │  Cloud   │
   └──────────┘        └──────────┘        └──────────┘
```

## Components Deployed

| Component | Type | Resources |
|-----------|------|-----------|
| **Temporal Worker** | Long-running | 1-5 replicas, 1 CPU, 2GB RAM |
| **Document Generator** | HTTP Agent | 0-10 replicas, 0.5 CPU, 1GB RAM |
| **Task Planner** | HTTP Agent | 0-10 replicas, 0.5 CPU, 1GB RAM |
| **Story Breakdown** | HTTP Agent | 0-10 replicas, 0.5 CPU, 1GB RAM |
| **API Agent** | HTTP Agent | 0-10 replicas, 0.5 CPU, 1GB RAM |
| **Prompt Enhancer** | HTTP Agent | 0-10 replicas, 0.5 CPU, 1GB RAM |
| **Project Doc Generator** | HTTP Agent | 0-10 replicas, 0.5 CPU, 1GB RAM |
| **CUGA (Python)** | HTTP Agent | 0-5 replicas, 1 CPU, 2GB RAM |

## Prerequisites

1. **Azure CLI** with Bicep extension
   ```bash
   az bicep install
   ```

2. **Docker** for building container images

3. **Azure Subscription** with Contributor access — sufficient for manual
   deployment (`deploy.sh`). The one-time OIDC setup below (step 4) needs
   more than Contributor; see that step for the actual requirement.

4. **GitHub Actions OIDC Authentication** (recommended)

   The deployment workflows use Azure OIDC (OpenID Connect) federated credentials,
   which is more secure than storing secrets. Run the setup script once per
   environment — dev and prod each get their own dedicated service principal.
   Isolation is one-directional, not absolute: the dev principal holds
   nothing in prod, but the prod principal holds one `Container Registry
   Data Importer and Data Reader` grant into the dev container registry
   (deliberately not `AcrPull`, which is insufficient for `az acr import`'s
   source-registry resolution — see the script header comment), because the
   dev-to-prod image promotion step (`deploy-azure-container-apps.yml`'s
   `promote-images` job) authenticates as the prod principal and needs to
   import the source image from dev. Running the script requires **Owner or
   User Access
   Administrator on the subscription**, plus an Entra role that permits
   registering applications (e.g. Application Administrator) — Contributor
   alone is not enough, since app registration and federated credentials are
   Entra directory operations, not subscription resource operations:

   ```bash
   cd deployment/azure
   chmod +x setup-github-oidc.sh
   ./setup-github-oidc.sh <github-org> <github-repo> <dev|prod> <acr-suffix>
   # Example: ./setup-github-oidc.sh Fabric-Pro fabric dev <acr-suffix>
   #          ./setup-github-oidc.sh Fabric-Pro fabric prod <acr-suffix>
   ```

   `<acr-suffix>` is this repository's `ACR_SUFFIX` variable value — the same
   one `deploy-azure-container-apps.yml` uses to derive the Key Vault name;
   pass the exact same value so the two never disagree on which vault to
   grant access to.

   For each environment, this script will:
   - Create a dedicated Azure AD App Registration and Service Principal
   - Configure a federated credential trusted only by that environment's
     GitHub Environment (`environment:dev` / `environment:Production`) —
     never a branch ref or `pull_request`
   - Assign Contributor scoped to that environment's resource group (never
     the subscription), plus a Role Based Access Control Administrator
     grant conditioned to only the specific built-in roles the pipeline
     itself requests
   - Output the secrets to add to that environment's GitHub Environment

5. **GitHub Environment Secrets** (required for CI/CD)

   Add these as **environment** secrets — not repository secrets — on the
   `dev` and `Production` GitHub Environments:
   - Go to: Settings > Environments > *(select dev or Production)* > Environment secrets

   Each environment gets its own values from its own run of the setup script
   above. Adding them as repository secrets instead would give every
   environment the same credential, defeating the per-environment isolation
   the setup script exists to provide.

   **Azure Authentication (required, once per environment):**
   | Secret Name | Description |
   |-------------|-------------|
   | `AZURE_CLIENT_ID` | Azure AD App Registration Client ID for this environment |
   | `AZURE_TENANT_ID` | Azure AD Tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |

   **Application Secrets (required for Temporal Worker):**
   | Secret Name | Description | Example |
   |-------------|-------------|---------|
   | `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db?sslmode=require` |
   | `TEMPORAL_ADDRESS` | Temporal server address | `your-namespace.tmprl.cloud:7233` |
   | `TEMPORAL_NAMESPACE` | Temporal namespace | `fabric-dev` |
   | `TEMPORAL_CLOUD_API_KEY` | Temporal Cloud API key | `tclt_...` |
   | `FABRIC_API_URL` | Fabric API URL (NextJS) | `https://fabric.example.com` |
   | `RESEND_API_KEY` | Resend API key for worker-sent emails (newsletter, notifications) | `re_...` |

   **RAG/Storage Secrets (required for document processing):**
   | Secret Name | Description | Example |
   |-------------|-------------|---------|
   | `QDRANT_URL` | Qdrant server URL | `https://xxx.us-east4-0.gcp.cloud.qdrant.io:6333` |
   | `QDRANT_API_KEY` | Qdrant API key | `qdrant_...` |
   | `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token | `vercel_blob_rw_...` |
   | `BLOB_STORE_ID` | Vercel Blob store ID | `store_...` |

   These secrets are automatically seeded to Azure Key Vault during deployment.

## Quick Start

### Manual Deployment

```bash
# Login to Azure
az login

# Deploy to dev environment
./deploy.sh dev

# Deploy to production
./deploy.sh prod
```

### CI/CD Deployment

The GitHub Actions workflow `.github/workflows/deploy-azure-container-apps.yml` handles automated deployments.

**Required GitHub Environment Secrets** (configured via `setup-github-oidc.sh`, once per environment):
- `AZURE_CLIENT_ID` - Azure AD App Registration Client ID for this environment
- `AZURE_TENANT_ID` - Azure AD Tenant ID
- `AZURE_SUBSCRIPTION_ID` - Azure Subscription ID

**Triggering Deployments:**
- Push to `master` (dev deploy) or a `v*.*.*` tag (prod deploy) — the canonical upstream branch is
  `master`, not `main`; see docs/deployment.md § Branch cutover checklist. There is deliberately no
  trigger-level path filter: per-component skipping is handled by the workflow's own
  `detect-changes` job and each downstream job's `if:` gate instead, because a trigger-level
  `paths`/`paths-ignore` filter applies to tag pushes too and can drop a legitimate `v*.*.*` release
  (observed on the v1.1.0 release) — see the `on:` block's own comment in
  `deploy-azure-container-apps.yml`.
- Manual trigger via GitHub Actions UI (workflow_dispatch)

## File Structure

```
deployment/azure/
├── main.bicep                 # Main infrastructure template
├── main.parameters.json       # Default parameters
├── deploy.sh                  # Manual deployment script
├── README.md                  # This file
├── modules/
│   ├── container-app.bicep    # Container App module
│   ├── secrets.bicep          # Key Vault module
│   ├── monitoring.bicep       # Alerts & action groups
│   └── dashboard.bicep        # Azure dashboard
└── parameters/
    ├── dev.bicepparam         # Dev environment params
    └── prod.bicepparam        # Prod environment params
```

## Configuration

### Adding Secrets to Key Vault

```bash
# Set secrets in Key Vault
az keyvault secret set --vault-name <key-vault> \
  --name database-url \
  --value "postgresql://user:pass@host:5432/db"

az keyvault secret set --vault-name <key-vault> \
  --name temporal-address \
  --value "your-namespace.tmprl.cloud:7233"

az keyvault secret set --vault-name <key-vault> \
  --name openai-api-key \
  --value "sk-..."
```

## Scaling

Container Apps automatically scale based on HTTP traffic. Configure scaling rules in `modules/container-app.bicep`:

```bicep
scale: {
  minReplicas: 0        // Scale to zero when idle (dev)
  maxReplicas: 10       // Maximum replicas
  rules: [
    {
      name: 'http-scaling'
      http: {
        metadata: {
          concurrentRequests: '50'  // Scale up at 50 concurrent requests
        }
      }
    }
  ]
}
```

## Monitoring

### View Logs

```bash
# Stream logs from a container app
az containerapp logs show \
  --name fabric-dev-temporal-worker \
  --resource-group <resource-group> \
  --follow

# Query logs in Log Analytics
az monitor log-analytics query \
  --workspace <log-analytics-workspace> \
  --analytics-query "ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'fabric-dev-temporal-worker'"
```

### Health Checks

All agents expose `/health` endpoints:

```bash
# Check agent health
curl https://fabric-dev-document-generator.{region}.azurecontainerapps.io/health
```

## Cost Estimation

| Environment | Estimated Monthly Cost |
|-------------|----------------------|
| **Dev** (scale to zero) | $30-50 |
| **Staging** (1 replica) | $80-120 |
| **Production** (HA) | $200-400 |

*Costs depend on usage patterns and scaling behavior.*

## Troubleshooting

### Common Issues

1. **Container fails to start**
   ```bash
   az containerapp revision list --name fabric-dev-temporal-worker --resource-group <resource-group>
   az containerapp logs show --name fabric-dev-temporal-worker --resource-group <resource-group>
   ```

2. **Secret not found**
   ```bash
   az keyvault secret list --vault-name <key-vault>
   ```

3. **Image pull failed**
   ```bash
   # Registry name is fabric<suffix>devacr. The suffix lives in the ACR_SUFFIX
   # repository variable — read it rather than guessing, since `<registry>`
   # (no suffix) is not a real registry:
   ACR_SUFFIX=$(gh variable get ACR_SUFFIX)
   ACR_NAME="fabric${ACR_SUFFIX}devacr"

   az acr repository list --name "$ACR_NAME"
   az acr repository show-tags --name "$ACR_NAME" --repository fabric/temporal-worker
   ```

## Connecting to External Services

### Temporal Cloud

Configure environment variables in the Temporal Worker container app:

```bash
az containerapp update \
  --name fabric-dev-temporal-worker \
  --resource-group <resource-group> \
  --set-env-vars \
    TEMPORAL_ADDRESS=secretref:temporal-address \
    TEMPORAL_NAMESPACE=your-namespace \
    TEMPORAL_CLOUD_API_KEY=secretref:temporal-api-key
```

### Neon PostgreSQL

```bash
az containerapp update \
  --name fabric-dev-temporal-worker \
  --resource-group <resource-group> \
  --set-env-vars \
    DATABASE_URL=secretref:database-url
```

## Monitoring & Alerting

The deployment includes comprehensive monitoring via Azure Monitor:

### Alert Rules

| Alert | Severity | Condition |
|-------|----------|-----------|
| **High CPU** | Warning (2) | CPU > 80% for 15 min |
| **High Memory** | Warning (2) | Memory > 80% for 15 min |
| **Max Replicas** | Info (3) | Replicas at maximum |
| **High Error Rate** | Critical (1) | >10 errors in 5 min window |
| **Container Restarts** | Warning (2) | >3 restarts in 30 min |
| **Temporal Unhealthy** | Critical (1) | Connection failures |

### Configuring Alert Notifications

```bash
# Deploy with email alerts
az deployment group create \
  --resource-group <resource-group> \
  --template-file deployment/azure/main.bicep \
  --parameters alertEmail=ops@example.com

# Add Slack webhook (via Key Vault secret)
az keyvault secret set --vault-name <key-vault> \
  --name slack-webhook-url \
  --value "https://hooks.slack.com/services/..."
```

### Viewing Logs & Metrics

```bash
# Query errors in last hour
az monitor log-analytics query \
  --workspace <log-analytics-workspace> \
  --analytics-query "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(1h) | where Log_s contains 'error'"

# View metrics
az monitor metrics list \
  --resource /subscriptions/{sub}/resourceGroups/<resource-group>/providers/Microsoft.App/managedEnvironments/<container-app-env> \
  --metric UsageNanoCores
```

## Next Steps

1. **Set up Temporal Cloud** - Create namespace and get API keys
2. **Configure Neon PostgreSQL** - Run Prisma migrations
3. **Set up Qdrant Cloud** - Create collections for RAG
4. **Configure DNS** - Point custom domains to Container Apps
5. **Enable HTTPS** - Container Apps provides automatic TLS
6. **Configure Alerts** - Set email/Slack notifications for monitoring

// =============================================================================
// Azure Container Apps Infrastructure for Fabric
// =============================================================================
// This Bicep template deploys:
// - Container Apps Environment
// - Temporal Worker Container App
// - LangGraph Agent Container Apps (document-generator, task-planner, etc.)
// - Container Registry
// - Log Analytics Workspace
// - Managed Identity
// =============================================================================

@description('Environment name (dev, prod)')
@allowed(['dev', 'prod'])
param envName string = 'dev'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Base name for resources')
param baseName string = 'fabric'

@description('Unique suffix for globally unique resources (ACR, Key Vault)')
param uniqueSuffix string = ''

@description('Container image tag (used as default for all components)')
param imageTag string = 'latest'

@description('Image tag for Temporal worker (overrides imageTag if set)')
param temporalImageTag string = ''

@description('Image tag for LangGraph agents (overrides imageTag if set)')
param agentsImageTag string = ''

@description('Image tag for MCP STDIO wrapper (overrides imageTag if set)')
param mcpWrapperImageTag string = ''

@description('Alert notification email (optional)')
param alertEmail string = ''

@description('Power Automate workflow webhook URL for alert notifications (optional)')
@secure()
param alertsWebhookUrl string = ''

@description('Enable monitoring and alerting')
param enableMonitoring bool = true

@description('Deploy the SOC 2 CC5.3/CC7.1 Azure Policy guardrails (audit effect). Requires the deploy identity to hold Resource Policy Contributor or equivalent — plain Contributor CANNOT create policy assignments. See modules/governance-policy.bicep.')
param enablePolicyGuardrails bool = false

@description('DEPRECATED: This parameter is no longer used. Azure Container Apps now uses a managed OpenTelemetry agent configured in the environment. Telemetry is automatically routed to Application Insights.')
param enableMultiDestinationOtlp bool = false

@description('Enable external access to Jaeger UI')
param enableJaegerExternalAccess bool = false

@description('Enable RAG/storage features (requires qdrant-url, qdrant-api-key, blob-read-write-token, blob-store-id secrets in Key Vault)')
param enableRag bool = true

@description('Enable Azure Cache for Redis for real-time streaming')
param enableRedis bool = true

@description('Wire Fabric GitHub OAuth client credentials from Key Vault (fabric-github-client-id, fabric-github-client-secret) into the temporal worker. Enable ONLY after those secrets exist in the environment Key Vault — otherwise the deployment fails on unresolved references. Leave disabled to use the DB-backed GITHUB_OAUTH_APP fallback in workflow_integration (see getGitHubClientCredentials()).')
param enableFabricGitHubOAuth bool = false

@description('Wire the Cloudflare sandbox worker (sandbox-worker-url, sandbox-auth-secret) from Key Vault into the temporal worker, which is what runs scripted QA cases. Enable ONLY after both secrets exist in the environment Key Vault — otherwise the deployment fails on unresolved references, the same trap enableFabricGitHubOAuth documents. While disabled, a scripted run blocks with "SANDBOX_WORKER_URL environment variable is required" rather than failing the deploy.')
param enableSandboxWorker bool = false

@description('Enable AST-aware code indexing (FEATURE_CODE_INDEXING) on the temporal worker. Enabled in every environment via the deploy workflow; a full re-embed consumes embedding credits (per-project opt-in still gates actual indexing via codeSearchEnabled).')
param enableCodeIndexing bool = false

@description('Living Documents auto-refresh SWEEP kill switch (FABRIC_FEATURE_LIVING_DOCS_REFRESH) on the temporal worker. TRUE in every environment, prod included — this is deliberately NOT the rollout switch, and since Fizzy #2210 it is registered as LIVING_DOCS_REFRESH_SWEEP rather than being read directly. What it buys is the brakes: the worker re-reads it immediately before it writes, so setting it false stops an AI mid-rollout. Rollout is a SEPARATE registry flag, LIVING_DOCS_REFRESH, whose env var is FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT — it governs the masthead control and the enrolment procedures together, and is off unless explicitly set. Both are now flippable from the admin console without a redeploy; this param is only the deployment default the override sits on top of. Set false only to hit the brakes.')
param enableLivingDocsRefresh bool = true

@description('Publishing Suite daily suggestion sweep (FABRIC_FEATURE_PUBLISHING_SUITE) on the temporal worker. Off by default (prod) — the deploy workflow enables it for non-prod only. This param only seeds the GLOBAL flag value; the find-eligible activity layers a per-organization PUBLISHING_SUITE override on top (database-backed, read on every tick, no cache), so it no longer determines who gets swept on its own — the sweep is restricted to organizations with an enabled override, or, when this is true, every organization except one with a disabled override. An organization can be enrolled individually regardless of this value; keep it false in prod until Publishing Suite is ready for a broad rollout.')
param enablePublishingSuite bool = false

@description('OpenAPI/Swagger specs as project context (FABRIC_FEATURE_OPENAPI_SPEC_CONTEXT) on the temporal worker, which is where every context-ingestion path runs. Off by default (prod) — the deploy workflow enables it for non-prod only. On, a detected spec is chunked per endpoint and per model instead of by character window; off, ingestion is byte-for-byte what it is today, so rollback is this param with no migration. Already-ingested specs keep the chunks they have until re-embedded, so flipping it on only changes what is uploaded next. Fizzy #2236.')
param enableOpenApiSpecContext bool = false

@description('Application-log context in bug analysis (FABRIC_FEATURE_BUG_ANALYSIS_LOG_CONTEXT) on the temporal worker. Off in prod; the deploy workflow enables it for non-prod only. Fizzy #1234 gates production rollout on the ADR-017 mechanism review, so this stays false for prod until that review lands. When true the worker also receives the provider selection and that provider\'s settings, pointing at THIS environment\'s workspace. The Log Analytics Reader grant is NOT made by this template: the deploy service principal cannot create role assignments, and giving it that right would let it grant any role in the resource group. It is a one-time operator step per environment (see the note where the assignment used to live). Until it is run the connector receives a 403, which degrades to "logs were not available" and affects nothing else. Reading is gated per request on the project-settings permission, structured properties are dropped unless explicitly allowlisted, and every entry is redacted before it reaches a model.')
param enableBugAnalysisLogContext bool = false

@description('Whether the deployment\'s own telemetry workspace may serve bug-analysis log lookups at all (FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE on the temporal worker). The security review of Fizzy #1234 held that an environment-wide workspace "shouldn\'t be a customer-facing source": scoping queries to an organization id alone would make it live the moment telemetry starts tagging org records, so serving it is a deliberate operator choice rather than a default. Off by default in every environment (prod included) — with it off every project gets FR3\'s "no log source configured" and only project bindings or tenant-connected MCP sources provide logs. Enable per environment once whoever owns the estate accepts that workspace as a customer-facing source for THIS deployment; the org predicate on shared-store queries still applies when it is on.')
param enableBugAnalysisLogSharedWorkspace bool = false

@description('QA / Test Cases suite (FABRIC_FEATURE_TEST_CASES) on the temporal worker, read with the STRICT literal-"true" reader. Gates the automatic pipeline-result sync sweep and QA evidence retention; the web app carries its own copy of the flag (Vercel) for the API gate and UI tab, so this param is what keeps the worker side of the feature alive across deploys rather than being a second rollout gate. Enabled in every environment via the deploy workflow (Fizzy #2144). Set false to stop the sweeps on the next tick.')
param enableTestCases bool = false

@description('Status-announcement notifications (FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED) on the temporal worker. TRUE in every environment, prod included — this is the KILL SWITCH, not the rollout switch, same shape as enableLivingDocsRefresh. The gate that decides whether customers hear anything is publishing the announcement itself: that is admin-only, human-authored, reviewed, and already customer-visible on the status page, so a separate default-off gate on the notification bought nothing except a feature nobody would ever switch on. What this param buys is the brakes — the sweeper re-reads the flag before it writes, so setting it false stops delivery on the next tick with no redeploy. Set false only to stop a misfire.')
param enableStatusAnnouncementNotifications bool = true

@description('Redis SKU (Basic C0 is cheapest at ~$15/month)')
@allowed(['Basic', 'Standard', 'Premium'])
param redisSku string = 'Basic'

@description('Databricks auth provider for Lakebase Postgres connections ("password" | "databricks-oauth")')
@allowed(['password', 'databricks-oauth'])
param databaseAuthProvider string = 'password'

@description('RLS enforcement mode for the temporal worker ("bypassrls" | "policy")')
@allowed(['bypassrls', 'policy'])
param workerRlsMode string = 'bypassrls'

@description('Encryption key version that NEW data is encrypted with (SOC 2 CC6.1 key rotation). Empty leaves rotation inactive, which is a fully supported setup: encryption falls back to BETTER_AUTH_SECRET and every existing ciphertext still decrypts. The deploy workflow sets this only once the environment\'s Key Vault actually holds that version\'s material, because activating a version whose material is absent fails EVERY stored-credential read (the lookup is lazy, so the process boots clean and then poisons the work it accepts). Defaults empty so a freshly-provisioned environment is never born broken. See your operator\'s key-rotation runbook.')
param encryptionActiveKeyVersion string = ''

// Tags for resources
var tags = {
  environment: envName
  application: 'fabric'
  managedBy: 'bicep'
}

// =============================================================================
// Variables
// =============================================================================

var resourcePrefix = '${baseName}-${envName}'
// ACR and Key Vault names must be globally unique - use suffix if provided
var actualSuffix = uniqueSuffix != '' ? uniqueSuffix : uniqueString(resourceGroup().id)
var containerRegistryName = replace('${baseName}${actualSuffix}${envName}acr', '-', '')
var keyVaultName = '${baseName}-${take(actualSuffix, 4)}-${envName}-kv'
var logAnalyticsName = '${resourcePrefix}-logs'
var containerEnvName = '${resourcePrefix}-env'
var managedIdentityName = '${resourcePrefix}-identity'

// Resolve per-component image tags: use component-specific override if set, otherwise fall back to imageTag
var resolvedTemporalTag = temporalImageTag != '' ? temporalImageTag : imageTag
var resolvedAgentsTag = agentsImageTag != '' ? agentsImageTag : imageTag
var resolvedMcpWrapperTag = mcpWrapperImageTag != '' ? mcpWrapperImageTag : imageTag

// DEPRECATED: otlpEndpoint variable
// The managed OpenTelemetry agent in the Container Apps Environment now handles
// routing telemetry to Application Insights automatically.
// OTEL_EXPORTER_OTLP_ENDPOINT should NOT be set manually - the managed agent
// auto-injects the correct endpoint for Application Insights integration.

// =============================================================================
// Log Analytics Workspace
// =============================================================================

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // SOC 2 CC7.1/CC7.2 (register L4): 90-day interactive retention so the audit /
    // observation window is covered (was 30). Longer archival (365d) via a
    // per-table archive tier is a cost decision left to the DRI.
    retentionInDays: 90
  }
}

// =============================================================================
// User Assigned Managed Identity
// =============================================================================

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
}

// =============================================================================
// Container Registry
// =============================================================================

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    // Admin user disabled (SOC 2 CC6.1/CC8.1). Image push uses the deploy
    // service principal (`az acr login` → AAD) and Container Apps pull via the
    // managed identity's AcrPull role — nothing uses the admin username/password,
    // so disabling it removes a redundant static-credential surface. Applied to
    // the existing ACR automatically on the next `arm-deploy` of this template.
    adminUserEnabled: false
  }
}

// Role assignment for managed identity to pull images
resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, managedIdentity.id, 'acrpull')
  scope: containerRegistry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d') // AcrPull
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Log Analytics Reader for the worker is granted OUT OF BAND, not here.
//
// This template used to declare that role assignment. It broke every
// infrastructure deploy: the deploy service principal does not hold
// `Microsoft.Authorization/roleAssignments/write` on fabric-dev-rg, so ARM
// rejected the whole template — not just the log feature, the entire
// deployment. Adding a roleAssignments resource to this template requires
// giving the deploy SP User Access Administrator, which would let it grant
// ANY role to anything in the resource group. That is a much larger permission
// than this feature is worth, and it is the estate owner's call, not a
// side effect of shipping a flag.
//
// So the grant is a one-time operator step, run by somebody who already has
// the rights, per environment:
//
//   az role assignment create \
//     --assignee-object-id <worker managed identity principalId> \
//     --assignee-principal-type ServicePrincipal \
//     --role "Log Analytics Reader" \
//     --scope <log analytics workspace resource id>
//
// Until it is run the connector receives a 403, which the feature already
// degrades to "logs were not available" — the analysis still succeeds and the
// user is told why. Nothing else is affected, and no redeploy is needed once
// the role lands.

// =============================================================================
// Application Insights (for dev/prod telemetry)
// =============================================================================

module appInsights 'modules/application-insights.bicep' = {
  name: 'application-insights'
  params: {
    resourcePrefix: resourcePrefix
    location: location
    logAnalyticsWorkspaceId: logAnalytics.id
    tags: tags
  }
}

// =============================================================================
// Container Apps Environment
// =============================================================================

resource containerEnv 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: containerEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    // Application Insights integration (for dev/prod environments)
    // Local development uses Aspire Dashboard (via OTEL_EXPORTER_OTLP_ENDPOINT env var)
    appInsightsConfiguration: {
      connectionString: appInsights.outputs.connectionString
    }
    // Managed OpenTelemetry agent configuration
    // Routes telemetry from containers to Application Insights
    openTelemetryConfiguration: {
      tracesConfiguration: {
        destinations: ['appInsights']
      }
      logsConfiguration: {
        destinations: ['appInsights']
      }
      // Note: Application Insights doesn't accept metrics via OTLP
      // Metrics are collected via Application Insights SDK instrumentation
    }
    // Zone redundancy requires InfrastructureSubnetId (VNet). Disabled until VNet is provisioned.
    zoneRedundant: false
  }
}

// =============================================================================
// Azure Cache for Redis (for real-time execution streaming)
// =============================================================================

resource redisCache 'Microsoft.Cache/redis@2024-03-01' = if (enableRedis) {
  name: '${baseName}-redis-${envName}${uniqueSuffix}'
  location: location
  properties: {
    sku: {
      name: redisSku
      family: redisSku == 'Premium' ? 'P' : 'C'
      capacity: 0
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    redisConfiguration: {
      'maxmemory-policy': 'volatile-lru'
    }
  }
  tags: {
    environment: envName
    application: baseName
  }
}

// =============================================================================
// Container Apps - Temporal Worker
// =============================================================================

// Key Vault URL base for secrets (using az.environment() to avoid conflict with environment parameter)
var kvBaseUrl = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets'

// Base secrets required for temporal worker
var temporalWorkerBaseSecrets = [
  // Worker-specific connection string (fabric_worker role on Lakebase). The
  // deploy workflow syncs it from the WORKER_DATABASE_URL GitHub secret,
  // falling back to DATABASE_URL when unset — so Neon environments are unchanged.
  { name: 'worker-database-url', keyVaultUrl: '${kvBaseUrl}/worker-database-url', identity: managedIdentity.id }
  { name: 'temporal-address', keyVaultUrl: '${kvBaseUrl}/temporal-address', identity: managedIdentity.id }
  { name: 'temporal-namespace', keyVaultUrl: '${kvBaseUrl}/temporal-namespace', identity: managedIdentity.id }
  { name: 'temporal-api-key', keyVaultUrl: '${kvBaseUrl}/temporal-api-key', identity: managedIdentity.id }
  { name: 'fabric-api-url', keyVaultUrl: '${kvBaseUrl}/fabric-api-url', identity: managedIdentity.id }
  { name: 'better-auth-secret', keyVaultUrl: '${kvBaseUrl}/better-auth-secret', identity: managedIdentity.id }
  // Versioned encryption keys (SOC 2 CC6.1 key rotation) — JSON { "<version>": "<secret>" }.
  // Distributing the keys is inert; encryption only switches to a versioned key
  // once ENCRYPTION_ACTIVE_KEY_VERSION is set (separate, later change).
  { name: 'encryption-keys', keyVaultUrl: '${kvBaseUrl}/encryption-keys', identity: managedIdentity.id }
  { name: 'app-url', keyVaultUrl: '${kvBaseUrl}/app-url', identity: managedIdentity.id }
  // Service-to-service auth — worker sends Authorization: Bearer <key> when invoking LangGraph agents
  { name: 'agent-api-key', keyVaultUrl: '${kvBaseUrl}/agent-api-key', identity: managedIdentity.id }
  // Dedicated audit-log seal signing key + its rotation partner (SOC 2 FR-6).
  // Decouples seal validity from BETTER_AUTH_SECRET rotation; the runtime prefers
  // AUDIT_LOG_SIGNING_KEY and keeps -previous so old seals verify across a rotation
  // (see packages/database/prisma/queries/audit-log-seal.ts).
  { name: 'audit-log-signing-key', keyVaultUrl: '${kvBaseUrl}/audit-log-signing-key', identity: managedIdentity.id }
  { name: 'audit-log-signing-key-previous', keyVaultUrl: '${kvBaseUrl}/audit-log-signing-key-previous', identity: managedIdentity.id }
]

// Agent URL secrets (stored in Key Vault after deployment)
var agentUrlSecrets = [
  { name: 'document-generator-url', keyVaultUrl: '${kvBaseUrl}/document-generator-url', identity: managedIdentity.id }
  { name: 'project-document-generator-url', keyVaultUrl: '${kvBaseUrl}/project-document-generator-url', identity: managedIdentity.id }
  { name: 'task-planner-url', keyVaultUrl: '${kvBaseUrl}/task-planner-url', identity: managedIdentity.id }
  { name: 'story-breakdown-url', keyVaultUrl: '${kvBaseUrl}/story-breakdown-url', identity: managedIdentity.id }
  { name: 'api-agent-url', keyVaultUrl: '${kvBaseUrl}/api-agent-url', identity: managedIdentity.id }
  { name: 'prompt-enhancer-url', keyVaultUrl: '${kvBaseUrl}/prompt-enhancer-url', identity: managedIdentity.id }
  { name: 'data-analyst-url', keyVaultUrl: '${kvBaseUrl}/data-analyst-url', identity: managedIdentity.id }
  { name: 'backlog-updater-url', keyVaultUrl: '${kvBaseUrl}/backlog-updater-url', identity: managedIdentity.id }
  { name: 'mcp-stdio-wrapper-url', keyVaultUrl: '${kvBaseUrl}/mcp-stdio-wrapper-url', identity: managedIdentity.id }
  { name: 'weave-readers-url', keyVaultUrl: '${kvBaseUrl}/weave-readers-url', identity: managedIdentity.id }
  { name: 'weave-shuttle-url', keyVaultUrl: '${kvBaseUrl}/weave-shuttle-url', identity: managedIdentity.id }
  { name: 'weave-planners-url', keyVaultUrl: '${kvBaseUrl}/weave-planners-url', identity: managedIdentity.id }
]

// RAG/Storage secrets (only included when enableRag is true)
// Uses Cloudflare R2 (S3-compatible) for private document storage
var ragSecrets = [
  { name: 'qdrant-url', keyVaultUrl: '${kvBaseUrl}/qdrant-url', identity: managedIdentity.id }
  { name: 'qdrant-api-key', keyVaultUrl: '${kvBaseUrl}/qdrant-api-key', identity: managedIdentity.id }
  { name: 's3-endpoint', keyVaultUrl: '${kvBaseUrl}/s3-endpoint', identity: managedIdentity.id }
  { name: 's3-access-key-id', keyVaultUrl: '${kvBaseUrl}/s3-access-key-id', identity: managedIdentity.id }
  { name: 's3-secret-access-key', keyVaultUrl: '${kvBaseUrl}/s3-secret-access-key', identity: managedIdentity.id }
]

// Letta (Semantic Memory) secrets
var lettaSecrets = [
  { name: 'letta-base-url', keyVaultUrl: '${kvBaseUrl}/letta-base-url', identity: managedIdentity.id }
  { name: 'letta-api-key', keyVaultUrl: '${kvBaseUrl}/letta-api-key', identity: managedIdentity.id }
]

// Databricks workspace integration (optional — Lakebase / workspace auth)
// Wired unconditionally (like letta); ensure_secret placeholders in Key Vault
// keep references resolvable before real values are synced.
var databricksSecrets = [
  { name: 'databricks-host', keyVaultUrl: '${kvBaseUrl}/databricks-host', identity: managedIdentity.id }
  { name: 'databricks-client-id', keyVaultUrl: '${kvBaseUrl}/databricks-client-id', identity: managedIdentity.id }
  { name: 'databricks-client-secret', keyVaultUrl: '${kvBaseUrl}/databricks-client-secret', identity: managedIdentity.id }
  { name: 'databricks-token', keyVaultUrl: '${kvBaseUrl}/databricks-token', identity: managedIdentity.id }
]

// PartyKit (Real-time Collaboration) secrets
var partykitSecrets = [
  { name: 'partykit-host', keyVaultUrl: '${kvBaseUrl}/partykit-host', identity: managedIdentity.id }
  { name: 'collab-jwt-secret', keyVaultUrl: '${kvBaseUrl}/collab-jwt-secret', identity: managedIdentity.id }
  { name: 'agent-service-secret', keyVaultUrl: '${kvBaseUrl}/agent-service-secret', identity: managedIdentity.id }
]

// Sandbox worker (Cloudflare Worker) secret and environment variables
var sandboxSecrets = [
  { name: 'sandbox-worker-url', keyVaultUrl: '${kvBaseUrl}/sandbox-worker-url', identity: managedIdentity.id }
]

var sandboxEnv = [
  { name: 'SANDBOX_API_URL', secretRef: 'sandbox-worker-url' }
]

// The same worker, under the names `@repo/sandbox` actually reads.
//
// `createSandboxClient()` requires SANDBOX_WORKER_URL and SANDBOX_AUTH_SECRET and
// throws on the first missing one. The agent sidecars above get SANDBOX_API_URL,
// which is a different name and carries no secret — so the temporal worker, which
// is what runs scripted QA cases, had neither. Every scripted run blocked on
// "SANDBOX_WORKER_URL environment variable is required" before reaching a browser.
//
// `deploy-temporal-only.bicep` already wires both. That template is not what CI
// deploys, so the wiring never reached a real environment; these two vars are that
// file's lines 268-269, in the template that does.
var sandboxWorkerSecrets = enableSandboxWorker ? [
  { name: 'sandbox-worker-url', keyVaultUrl: '${kvBaseUrl}/sandbox-worker-url', identity: managedIdentity.id }
  { name: 'sandbox-auth-secret', keyVaultUrl: '${kvBaseUrl}/sandbox-auth-secret', identity: managedIdentity.id }
] : []

var sandboxWorkerEnv = enableSandboxWorker ? [
  { name: 'SANDBOX_WORKER_URL', secretRef: 'sandbox-worker-url' }
  { name: 'SANDBOX_AUTH_SECRET', secretRef: 'sandbox-auth-secret' }
] : []

// Background Agents (Coding Runs) secrets
var backgroundAgentsSecrets = [
  { name: 'background-agents-url', keyVaultUrl: '${kvBaseUrl}/background-agents-url', identity: managedIdentity.id }
  { name: 'background-agents-internal-secret', keyVaultUrl: '${kvBaseUrl}/background-agents-internal-secret', identity: managedIdentity.id }
]

// Background Agents (Coding Runs) environment variables
var backgroundAgentsEnv = [
  { name: 'BACKGROUND_AGENTS_URL', secretRef: 'background-agents-url' }
  { name: 'BACKGROUND_AGENTS_INTERNAL_SECRET', secretRef: 'background-agents-internal-secret' }
]

// Fabric Internal (coding-run bridge for Shuttle) secrets
var fabricInternalSecrets = [
  { name: 'fabric-internal-url', keyVaultUrl: '${kvBaseUrl}/fabric-internal-url', identity: managedIdentity.id }
]

// Fabric Internal environment variables (Shuttle uses AGENT_SERVICE_SECRET for bridge auth)
var fabricInternalEnv = [
  { name: 'FABRIC_INTERNAL_URL', secretRef: 'fabric-internal-url' }
]

// Redis (real-time execution streaming) secrets
var redisSecrets = [
  { name: 'redis-url', keyVaultUrl: '${kvBaseUrl}/redis-url', identity: managedIdentity.id }
]

// Redis environment variables
var redisEnv = [
  { name: 'REDIS_URL', secretRef: 'redis-url' }
]

// Seed user email — fallback userId hint for SYSTEM-scope agent embeddings.
// Single email or comma-separated priority list. Pre-populated as a placeholder
// in the Pre-populate step so the Key Vault reference always resolves.
var seedUserSecrets = [
  { name: 'seed-user-email', keyVaultUrl: '${kvBaseUrl}/seed-user-email', identity: managedIdentity.id }
]

var seedUserEnv = [
  { name: 'SEED_USER_EMAIL', secretRef: 'seed-user-email' }
]

// Microsoft Graph (OAuth integration) secrets
var microsoftGraphSecrets = [
  { name: 'microsoft-graph-client-id', keyVaultUrl: '${kvBaseUrl}/microsoft-graph-client-id', identity: managedIdentity.id }
  { name: 'microsoft-graph-client-secret', keyVaultUrl: '${kvBaseUrl}/microsoft-graph-client-secret', identity: managedIdentity.id }
]

// Microsoft Graph environment variables
var microsoftGraphEnv = [
  { name: 'MICROSOFT_GRAPH_CLIENT_ID', secretRef: 'microsoft-graph-client-id' }
  { name: 'MICROSOFT_GRAPH_CLIENT_SECRET', secretRef: 'microsoft-graph-client-secret' }
]

// GitHub OAuth app (project repository integrations) secrets. Required for
// `refreshProjectRepoGitHubToken` to exchange refresh tokens via env vars.
// Opt-out (`enableFabricGitHubOAuth = false`) for deploys that configure the
// OAuth app through the DB fallback (`workflow_integration.name =
// 'GITHUB_OAUTH_APP'`) instead of the Key Vault secrets — the fallback lookup
// in `getGitHubClientCredentials()` handles those environments, but Container
// Apps would otherwise fail deployment on missing Key Vault references.
var fabricGitHubSecrets = enableFabricGitHubOAuth ? [
  { name: 'fabric-github-client-id', keyVaultUrl: '${kvBaseUrl}/fabric-github-client-id', identity: managedIdentity.id }
  { name: 'fabric-github-client-secret', keyVaultUrl: '${kvBaseUrl}/fabric-github-client-secret', identity: managedIdentity.id }
] : []

var fabricGitHubEnv = enableFabricGitHubOAuth ? [
  { name: 'FABRIC_GITHUB_CLIENT_ID', secretRef: 'fabric-github-client-id' }
  { name: 'FABRIC_GITHUB_CLIENT_SECRET', secretRef: 'fabric-github-client-secret' }
] : []

// Code indexing (Phase 2 AST-aware). The worker workflow gate reads
// FEATURE_CODE_INDEXING; the deploy workflow now sets enableCodeIndexing=true in
// every environment (prod included). Actual indexing per project is still gated
// by the project's codeSearchEnabled RAG setting (opt-in).
var codeIndexingEnv = enableCodeIndexing ? [
  { name: 'FEATURE_CODE_INDEXING', value: 'true' }
] : []

// Living Documents auto-refresh. The hourly schedule is registered by
// registerSystemSchedules() no matter what; the gate lives in the find-due
// activity, so flipping this on takes effect on the next tick. Opt-in
// (parseOptInFlag), and the FABRIC_ prefix is load-bearing — turbo.json passes
// FABRIC_* through by wildcard and a bare FEATURE_* name would not reach the app.
var livingDocsRefreshEnv = enableLivingDocsRefresh ? [
  { name: 'FABRIC_FEATURE_LIVING_DOCS_REFRESH', value: 'true' }
] : []

// Publishing Suite daily suggestion sweep (Phase 1A; per-organization scoping
// added by the org-scoped-flags slice). The dispatcher's find-eligible
// activity deliberately does NOT resolve this via isFeatureEnabled — an
// earlier fix replaced that call with getGlobalFlagOverride (an uncached
// direct read) plus resolveFlag, because isFeatureEnabled's 10-second TTL
// cache is wrong for a credit-spending decision made once per tick. It reads
// the PUBLISHING_SUITE registry entry whose envVar is
// FABRIC_FEATURE_PUBLISHING_SUITE and layers a per-organization database
// override on top, the same uncached way (see the enablePublishingSuite
// param description above). This var is only the global seed: with it off,
// the sweep is restricted to organizations with an enabled override (and
// returns an empty due-list immediately if none exist); with it on, every
// organization is swept except one with a disabled override. Off by default
// (prod-safe); the deploy workflow sets it true for non-prod only. FABRIC_
// prefix is load-bearing (turbo passthrough).
var publishingSuiteEnv = enablePublishingSuite ? [
  { name: 'FABRIC_FEATURE_PUBLISHING_SUITE', value: 'true' }
] : []

// OpenAPI/Swagger specs as project context (Fizzy #2236). Gates
// `routeContentForChunking`, which every context-ingestion activity routes
// through — the wizard's processing and embedding activities, project-context
// processing, and auto-embed — so this one variable covers the whole server
// half. Read as an env var (parseOptInFlag), NOT from the feature-flag override
// table: the gate is synchronous and the DB-backed reader is async, so the
// admin console's toggle for this key never reaches it. FABRIC_ prefix is
// load-bearing (turbo passthrough).
var openApiSpecContextEnv = enableOpenApiSpecContext ? [
  { name: 'FABRIC_FEATURE_OPENAPI_SPEC_CONTEXT', value: 'true' }
] : []

// Application-log context for bug analysis (Fizzy #1234). Three variables move
// together because any one alone is inert: the feature gate, which provider to
// use, and that provider's own configuration. The workspace id is read from the
// Log Analytics resource this template already creates, so it is correct per
// environment and no infrastructure identifier is hardcoded in the repo.
// Nothing outside the provider registry is bound to Azure — pointing a
// deployment at Loki, Elastic or anything else means changing
// FABRIC_BUG_ANALYSIS_LOG_PROVIDER and that provider's own settings, with no
// change to the feature itself. FABRIC_ prefix is load-bearing (turbo
// passthrough).
var bugAnalysisLogContextEnv = enableBugAnalysisLogContext ? [
  { name: 'FABRIC_FEATURE_BUG_ANALYSIS_LOG_CONTEXT', value: 'true' }
  { name: 'FABRIC_BUG_ANALYSIS_LOG_PROVIDER', value: 'azure-monitor' }
  { name: 'FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID', value: logAnalytics.properties.customerId }
  // The worker holds ONLY user-assigned identities, and the Azure Identity
  // library will not infer one: without a client id it asks for the
  // system-assigned identity, gets nothing, and the token request fails in a
  // way that reads exactly like a missing role assignment. Taken from the
  // identity resource, so nothing is hardcoded here either.
  { name: 'FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID', value: managedIdentity.properties.clientId }
] : []

// Serving the deployment-wide workspace to analyses is opt-in (security review
// of Fizzy #1234): without this entry fromEnvironment() returns null even when
// the provider and workspace are configured above, so projects get FR3's
// "no log source configured". Only meaningful when the block above is on.
var bugAnalysisLogSharedWorkspaceEnv = enableBugAnalysisLogContext && enableBugAnalysisLogSharedWorkspace ? [
  { name: 'FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE', value: 'true' }
] : []

// QA / Test Cases suite (FABRIC_FEATURE_TEST_CASES). The worker reads it with
// the STRICT literal-"true" reader and gates the pipeline-result sync sweep and
// evidence retention on it; the web app carries its own copy of the flag for
// the API gate and UI tab. FABRIC_ prefix is load-bearing (turbo passthrough).
var testCasesEnv = enableTestCases ? [
  { name: 'FABRIC_FEATURE_TEST_CASES', value: 'true' }
] : []

// Status-announcement notifications. The 5-minute schedule is registered by
// ensureMonitoringSchedules() no matter what; the gate lives in the sweeper,
// which returns skipped without issuing a single query when off — so flipping
// this takes effect on the next tick with no redeploy. ON by default in every
// environment: publishing the announcement is the reviewed, admin-only,
// already-customer-visible decision, and this flag is the kill switch for a
// misfire rather than the rollout gate. FABRIC_ prefix is load-bearing (turbo
// passthrough).
var statusAnnouncementNotificationsEnv = enableStatusAnnouncementNotifications ? [
  { name: 'FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED', value: 'true' }
] : []

// GitLab OAuth app (codebase + PM integrations) secrets. Required by
// getGitLabClientCredentials() for the OAuth token exchange and refresh —
// the temporal-worker refreshes GitLab tokens while running PM sync step
// activities, so without these the worker cannot refresh an expired token
// (~2h lifetime) and PM pull/push fails. Wired unconditionally (like
// Microsoft Graph); the ensure_secret placeholders keep the Key Vault
// reference resolvable before real values are synced.
var gitLabSecrets = [
  { name: 'gitlab-client-id', keyVaultUrl: '${kvBaseUrl}/gitlab-client-id', identity: managedIdentity.id }
  { name: 'gitlab-client-secret', keyVaultUrl: '${kvBaseUrl}/gitlab-client-secret', identity: managedIdentity.id }
]

var gitLabEnv = [
  { name: 'GITLAB_CLIENT_ID', secretRef: 'gitlab-client-id' }
  { name: 'GITLAB_CLIENT_SECRET', secretRef: 'gitlab-client-secret' }
]

// Atlassian Cloud OAuth — hybrid 3LO chained off the primary Rovo MCP
// OAuth. Used by `mcp.atlassianCloud.start` + `callback` (Next.js route)
// and `refreshAtlassianCloudToken` (temporal-worker). Wired
// unconditionally — `ensure_secret` writes placeholder values when the
// real secrets aren't synced yet, and the application code's env-var
// presence check (`getEnvCredentials()` in
// `procedures/atlassian-cloud.ts`) treats a placeholder as "not
// configured" the same as a missing env var. Without these the PM-sync
// image-upload path silently degrades to base64 inline.
var atlassianCloudSecrets = [
  { name: 'atlassian-cloud-oauth-client-id', keyVaultUrl: '${kvBaseUrl}/atlassian-cloud-oauth-client-id', identity: managedIdentity.id }
  { name: 'atlassian-cloud-oauth-client-secret', keyVaultUrl: '${kvBaseUrl}/atlassian-cloud-oauth-client-secret', identity: managedIdentity.id }
]

var atlassianCloudEnv = [
  { name: 'ATLASSIAN_CLOUD_OAUTH_CLIENT_ID', secretRef: 'atlassian-cloud-oauth-client-id' }
  { name: 'ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET', secretRef: 'atlassian-cloud-oauth-client-secret' }
]

// Base environment variables
var temporalWorkerBaseEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DATABASE_URL', secretRef: 'worker-database-url' }
  { name: 'TEMPORAL_ADDRESS', secretRef: 'temporal-address' }
  { name: 'TEMPORAL_NAMESPACE', secretRef: 'temporal-namespace' }
  { name: 'TEMPORAL_CLOUD_API_KEY', secretRef: 'temporal-api-key' }
  { name: 'FABRIC_API_URL', secretRef: 'fabric-api-url' }
  { name: 'BETTER_AUTH_SECRET', secretRef: 'better-auth-secret' }
  // Versioned encryption keys for at-rest secret columns (SOC 2 CC6.1).
  // Decrypt-capability only until ENCRYPTION_ACTIVE_KEY_VERSION is also set.
  { name: 'ENCRYPTION_KEYS', secretRef: 'encryption-keys' }
  // Key-rotation flip (SOC 2 CC6.1). Resolved by the deploy workflow from what
  // this environment's vault actually holds, never hardcoded here: the previous
  // literal '2' for every non-prod environment guaranteed that a newly-created
  // environment — whose `encryption-keys` secret the deploy only ever seeds as
  // the `{}` placeholder — activated a version it had no material for.
  // '' is treated as unset — see your operator's key-rotation runbook for
  // the rotation procedure.
  { name: 'ENCRYPTION_ACTIVE_KEY_VERSION', value: encryptionActiveKeyVersion }
  // Public-facing site origin used to build absolute share URLs in
  // fabric_create_frame and other activities that emit user-clickable links.
  { name: 'APP_URL', secretRef: 'app-url' }
  // Service-to-service auth for Temporal activities calling LangGraph agents
  // (agent-core auth middleware accepts Authorization: Bearer <AGENT_API_KEY>)
  { name: 'AGENT_API_KEY', secretRef: 'agent-api-key' }
  // OpenTelemetry configuration - OTEL_EXPORTER_OTLP_ENDPOINT is injected by sidecar module
  { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: 'grpc' }
  { name: 'OTEL_SERVICE_NAME', value: 'temporal-worker' }
  { name: 'OTEL_ENABLED', value: enableMonitoring ? 'true' : 'false' }
  // Tamper-evident audit-log sealing (SOC 2 CC7.1/CC7.2, card 1721 FR-6). When
  // "true", the worker registers the hourly `audit-log-seal` schedule that
  // HMAC-signs a chained digest over each window of audit_log rows (off the
  // audit insert hot path). Signing key: AUDIT_LOG_SIGNING_KEY (secrets manager)
  // preferred, else derived from BETTER_AUTH_SECRET. Verify on demand with
  // `pnpm --filter @repo/database verify:audit-seals`.
  { name: 'FABRIC_AUDIT_LOG_SEALING_ENABLED', value: 'true' }
  // Dedicated signing key (preferred over the BETTER_AUTH_SECRET-derived fallback)
  // and its rotation partner, injected from Key Vault via secretRef — never emitted
  // in plaintext template output or env listings.
  { name: 'AUDIT_LOG_SIGNING_KEY', secretRef: 'audit-log-signing-key' }
  { name: 'AUDIT_LOG_SIGNING_KEY_PREVIOUS', secretRef: 'audit-log-signing-key-previous' }
  // Cap V8's old-space below the 3.5 GiB container so it garbage-collects
  // instead of being cgroup-OOM-killed. 2.5 GiB heap leaves ~1 GiB for native
  // memory (tree-sitter wasm, Prisma engine, the workflow bundle, buffers).
  { name: 'NODE_OPTIONS', value: '--max-old-space-size=2560' }
]

// Agent URL environment variables
var agentUrlEnv = [
  { name: 'DOCUMENT_GENERATOR_URL', secretRef: 'document-generator-url' }
  { name: 'PROJECT_DOCUMENT_GENERATOR_URL', secretRef: 'project-document-generator-url' }
  { name: 'TASK_PLANNER_URL', secretRef: 'task-planner-url' }
  { name: 'STORY_BREAKDOWN_URL', secretRef: 'story-breakdown-url' }
  { name: 'API_AGENT_URL', secretRef: 'api-agent-url' }
  { name: 'PROMPT_ENHANCER_URL', secretRef: 'prompt-enhancer-url' }
  { name: 'BACKLOG_UPDATER_URL', secretRef: 'backlog-updater-url' }
  // MCP STDIO Wrapper runs as a standalone container app with external ingress
  { name: 'MCP_STDIO_WRAPPER_URL', secretRef: 'mcp-stdio-wrapper-url' }
  // API key for authenticating with the MCP STDIO Wrapper
  { name: 'MCP_WRAPPER_API_KEY', secretRef: 'mcp-wrapper-api-key' }
  // Weave multi-agent orchestration URLs
  { name: 'WEAVE_READERS_URL', secretRef: 'weave-readers-url' }
  { name: 'WEAVE_SHUTTLE_URL', secretRef: 'weave-shuttle-url' }
  { name: 'WEAVE_PLANNERS_URL', secretRef: 'weave-planners-url' }
]

// RAG/Storage environment variables (only included when enableRag is true)
// Uses S3-compatible storage (Cloudflare R2) for private documents
// Bucket names are environment-specific: prod uses prod-* prefixed buckets
var bucketPrefix = envName == 'prod' ? 'prod-' : ''
var ragEnv = [
  { name: 'QDRANT_URL', secretRef: 'qdrant-url' }
  { name: 'QDRANT_API_KEY', secretRef: 'qdrant-api-key' }
  { name: 'S3_ENDPOINT', secretRef: 's3-endpoint' }
  { name: 'S3_ACCESS_KEY_ID', secretRef: 's3-access-key-id' }
  { name: 'S3_SECRET_ACCESS_KEY', secretRef: 's3-secret-access-key' }
  { name: 'S3_REGION', value: 'auto' }
  { name: 'STORAGE_PROVIDER', value: 's3' }
  { name: 'NEXT_PUBLIC_AVATARS_BUCKET_NAME', value: '${bucketPrefix}avatars' }
  { name: 'NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME', value: '${bucketPrefix}chat-documents' }
  { name: 'NEXT_PUBLIC_PROJECT_CONTEXTS_BUCKET_NAME', value: '${bucketPrefix}project-contexts' }
  { name: 'WORKSPACE_DOCUMENTS_BUCKET_NAME', value: '${bucketPrefix}workspace-documents' }
  { name: 'SKILLS_BUCKET_NAME', value: '${bucketPrefix}skills' }
  { name: 'PROJECT_DOCUMENT_ASSETS_BUCKET_NAME', value: '${bucketPrefix}project-document-assets' }
]

// Letta (Semantic Memory) environment variables
var lettaEnv = [
  { name: 'LETTA_BASE_URL', secretRef: 'letta-base-url' }
  { name: 'LETTA_API_KEY', secretRef: 'letta-api-key' }
]

// Databricks workspace integration environment variables
// Plain-value entries for auth provider and RLS mode are included here
// (harmless on any component that doesn't use them). WORKER_RLS_MODE is
// placed here rather than in a temporal-only array for simplicity — it
// is ignored by components that don't consume it.
var databricksEnv = [
  { name: 'DATABRICKS_HOST', secretRef: 'databricks-host' }
  { name: 'DATABRICKS_CLIENT_ID', secretRef: 'databricks-client-id' }
  { name: 'DATABRICKS_CLIENT_SECRET', secretRef: 'databricks-client-secret' }
  { name: 'DATABRICKS_TOKEN', secretRef: 'databricks-token' }
  { name: 'DATABASE_AUTH_PROVIDER', value: databaseAuthProvider }
  { name: 'WORKER_RLS_MODE', value: workerRlsMode }
]

// PartyKit (Real-time Collaboration) environment variables
var partykitEnv = [
  { name: 'NEXT_PUBLIC_PARTYKIT_HOST', secretRef: 'partykit-host' }
  { name: 'COLLAB_JWT_SECRET', secretRef: 'collab-jwt-secret' }
  { name: 'AGENT_SERVICE_SECRET', secretRef: 'agent-service-secret' }
]

// MCP STDIO Wrapper API key secret (used by temporal-worker and the standalone wrapper)
var mcpWrapperSecrets = [
  { name: 'mcp-wrapper-api-key', keyVaultUrl: '${kvBaseUrl}/mcp-wrapper-api-key', identity: managedIdentity.id }
]

// Mail (Resend) secret — the temporal-worker sends newsletter and notification
// emails through @repo/mail's Resend provider. getResendClient() throws when
// RESEND_API_KEY is unset, so every worker-originated send fails without it.
// The web app receives this via Vercel, but the worker is a separate container.
// Wired unconditionally; the ensure_secret placeholder keeps the Key Vault
// reference resolvable before the real value is synced.
var mailSecrets = [
  { name: 'resend-api-key', keyVaultUrl: '${kvBaseUrl}/resend-api-key', identity: managedIdentity.id }
]

var mailEnv = [
  { name: 'RESEND_API_KEY', secretRef: 'resend-api-key' }
]

// Combine all secrets and env vars for temporal worker
// Note: mcpWrapperSecrets is included so temporal-worker can authenticate with the standalone MCP STDIO wrapper
var allTemporalSecrets = concat(temporalWorkerBaseSecrets, sandboxWorkerSecrets, agentUrlSecrets, enableRag ? ragSecrets : [], lettaSecrets, databricksSecrets, partykitSecrets, backgroundAgentsSecrets, microsoftGraphSecrets, fabricGitHubSecrets, gitLabSecrets, atlassianCloudSecrets, mcpWrapperSecrets, enableRedis ? redisSecrets : [], seedUserSecrets, mailSecrets)

var allTemporalEnv = concat(temporalWorkerBaseEnv, sandboxWorkerEnv, agentUrlEnv, enableRag ? ragEnv : [], lettaEnv, databricksEnv, partykitEnv, backgroundAgentsEnv, microsoftGraphEnv, fabricGitHubEnv, codeIndexingEnv, livingDocsRefreshEnv, publishingSuiteEnv, testCasesEnv, openApiSpecContextEnv, bugAnalysisLogContextEnv, bugAnalysisLogSharedWorkspaceEnv, statusAnnouncementNotificationsEnv, gitLabEnv, atlassianCloudEnv, enableRedis ? redisEnv : [], seedUserEnv, mailEnv)

module temporalWorker 'modules/container-app-sidecar.bicep' = {
  name: 'temporal-worker'
  dependsOn: [secrets]
  params: {
    name: '${resourcePrefix}-temporal-worker'
    location: location
    containerEnvId: containerEnv.id
    registryName: containerRegistry.name
    registryServer: containerRegistry.properties.loginServer
    managedIdentityId: managedIdentity.id
    image: '${containerRegistry.properties.loginServer}/fabric/temporal-worker:${resolvedTemporalTag}'
    // Non-HTTP service: no ingress
    targetPort: 0
    enableIngress: false
    containerName: 'temporal-worker'
    // Bumped from 1 vCPU / 2 GiB. This container hosts ~11 in-process Temporal
    // workers whose resident floor (~1.8 GiB) rode the 2 GiB ceiling and got
    // cgroup-OOM-killed roughly hourly, terminating long activities (Atlas /
    // code-indexing clone+parse) mid-run and adding retry latency across the
    // async backend. 3.5 GiB gives real headroom above the ~2.1 GiB peak.
    // Capped at 1.75 / 3.5 (not 2 / 4) because the Consumption profile bounds
    // the TOTAL of all containers, and the otel-collector sidecar adds 0.25 /
    // 0.5 — so worker + sidecar = 2.0 / 4.0, the Consumption maximum.
    cpu: '1.75'
    memory: '3.5Gi'
    minReplicas: 1
    maxReplicas: envName == 'prod' ? 5 : 2
    secrets: allTemporalSecrets
    env: allTemporalEnv
    appInsightsConnectionString: appInsights.outputs.connectionString
    deploymentEnvironment: envName
  }
}

// =============================================================================
// Key Vault for Secrets
// =============================================================================

module secrets 'modules/secrets.bicep' = {
  name: 'secrets'
  params: {
    keyVaultName: keyVaultName
    location: location
    environment: envName
  }
}

// Reference existing Key Vault (created by secrets module) for Redis secret
resource keyVaultRef 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Redis URL secret in Key Vault (for real-time execution streaming)
resource redisUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (enableRedis) {
  parent: keyVaultRef
  name: 'redis-url'
  properties: {
    value: enableRedis ? 'rediss://:${redisCache.listKeys().primaryKey}@${redisCache.properties.hostName}:${redisCache.properties.sslPort}' : ''
  }
}

// =============================================================================
// Diagnostic Settings -> Log Analytics (SOC 2 CC7.1/CC7.2 -- register L3)
// Routes ACR, Key Vault, and Redis control-plane audit logs + metrics to the
// workspace so administrative / secret-access events are centrally retained.
// Idempotent: re-applies the same named setting to the existing resources.
// NOTE: the setting is named 'soc2-diagnostics' deliberately -- a hand-created
// setting of that name already exists on the dev/prod ACR. Azure rejects a
// second diagnosticSetting claiming the same log category -> workspace sink, so
// we adopt the existing one in-place by matching its name instead of creating a
// colliding 'soc2-audit-to-law'. Do NOT rename without first deleting the
// pre-existing setting on every environment's ACR.
// =============================================================================

resource acrDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'soc2-diagnostics'
  scope: containerRegistry
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'soc2-diagnostics'
  scope: keyVaultRef
  dependsOn: [
    secrets
  ]
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// Redis (Basic/Standard) exposes metrics but not resource logs; metrics-only
// keeps the deployment valid across SKUs.
resource redisDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableRedis) {
  name: 'soc2-diagnostics'
  scope: redisCache
  properties: {
    workspaceId: logAnalytics.id
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// =============================================================================
// Container Apps - TypeScript LangGraph Agents
// =============================================================================

// Container App names must be <= 32 chars, lowercase alphanumeric and hyphens only
// Names must match the image names in ACR (fabric/<imageName>)
// Ports must match Dockerfiles, docker-compose, and Aspire configuration
var tsAgentConfigs = [
  { name: 'document-generator', imageName: 'document-generator', port: 8124, cpu: '0.5', memory: '1Gi' }
  { name: 'project-doc-gen', imageName: 'project-document-generator', port: 8125, cpu: '0.5', memory: '1Gi' }
  { name: 'task-planner', imageName: 'task-planner', port: 8126, cpu: '0.5', memory: '1Gi' }
  { name: 'story-breakdown', imageName: 'story-breakdown', port: 8127, cpu: '0.5', memory: '1Gi' }
  { name: 'data-analyst', imageName: 'data-analyst', port: 8130, cpu: '0.5', memory: '1Gi' }
  { name: 'api-agent', imageName: 'api-agent', port: 8131, cpu: '0.5', memory: '1Gi' }
  { name: 'prompt-enhancer', imageName: 'prompt-enhancer', port: 8134, cpu: '0.5', memory: '1Gi' }
  { name: 'backlog-updater', imageName: 'backlog-updater', port: 8135, cpu: '0.5', memory: '1Gi' }
  // Weave agents: higher CPU/memory — readers hosts 4 agents, shuttle bridges coding runs
  { name: 'weave-readers', imageName: 'weave-readers', port: 8140, cpu: '1.0', memory: '2Gi' }
  { name: 'weave-shuttle', imageName: 'weave-shuttle', port: 8141, cpu: '0.5', memory: '1Gi' }
  { name: 'weave-planners', imageName: 'weave-planners', port: 8142, cpu: '0.5', memory: '1Gi' }
]

module tsAgents 'modules/container-app-sidecar.bicep' = [for agent in tsAgentConfigs: {
  name: 'ts-${agent.name}'
  dependsOn: [secrets]
  params: {
    name: '${resourcePrefix}-${agent.name}'
    location: location
    containerEnvId: containerEnv.id
    registryName: containerRegistry.name
    registryServer: containerRegistry.properties.loginServer
    managedIdentityId: managedIdentity.id
    image: '${containerRegistry.properties.loginServer}/fabric/${agent.imageName}:${resolvedAgentsTag}'
    targetPort: agent.port
    enableIngress: true
    cpu: agent.cpu
    memory: agent.memory
    // Keep at least 1 replica to avoid cold start failures
    // Scale-to-zero causes first request failures after sleep
    minReplicas: 1
    maxReplicas: envName == 'prod' ? 10 : 3
    secrets: concat([
      { name: 'agent-api-key', keyVaultUrl: '${kvBaseUrl}/agent-api-key', identity: managedIdentity.id }
      { name: 'agent-service-secret', keyVaultUrl: '${kvBaseUrl}/agent-service-secret', identity: managedIdentity.id }
      { name: 'ai-token-secret', keyVaultUrl: '${kvBaseUrl}/ai-token-secret', identity: managedIdentity.id }
      { name: 'fabric-api-url', keyVaultUrl: '${kvBaseUrl}/fabric-api-url', identity: managedIdentity.id }
      { name: 'fabric-ai-api-key', keyVaultUrl: '${kvBaseUrl}/fabric-ai-api-key', identity: managedIdentity.id }
      { name: 'weave-readers-url', keyVaultUrl: '${kvBaseUrl}/weave-readers-url', identity: managedIdentity.id }
      { name: 'weave-shuttle-url', keyVaultUrl: '${kvBaseUrl}/weave-shuttle-url', identity: managedIdentity.id }
      { name: 'weave-planners-url', keyVaultUrl: '${kvBaseUrl}/weave-planners-url', identity: managedIdentity.id }
    ], sandboxSecrets, backgroundAgentsSecrets, agent.imageName == 'weave-planners' ? concat([
      { name: 'worker-database-url', keyVaultUrl: '${kvBaseUrl}/worker-database-url', identity: managedIdentity.id }
      // weave-planners opens Prisma (@repo/database), so it needs the same
      // Databricks auth wiring as the temporal worker for Lakebase OAuth mode.
    ], databricksSecrets) : [], agent.imageName == 'weave-shuttle' ? fabricInternalSecrets : [])
    env: concat([
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: string(agent.port) }
      { name: 'AGENT_API_KEY', secretRef: 'agent-api-key' }
      { name: 'AI_TOKEN_SECRET', secretRef: 'ai-token-secret' }
      { name: 'FABRIC_API_URL', secretRef: 'fabric-api-url' }
      { name: 'FABRIC_AI_API_KEY', secretRef: 'fabric-ai-api-key' }
      { name: 'AI_API_KEY', secretRef: 'fabric-ai-api-key' }
      { name: 'AGENT_SERVICE_SECRET', secretRef: 'agent-service-secret' }
      { name: 'WEAVE_READERS_URL', secretRef: 'weave-readers-url' }
      { name: 'WEAVE_SHUTTLE_URL', secretRef: 'weave-shuttle-url' }
      { name: 'WEAVE_PLANNERS_URL', secretRef: 'weave-planners-url' }
      // OpenTelemetry configuration - sidecar handles routing to App Insights
      { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: 'grpc' }
      { name: 'OTEL_SERVICE_NAME', value: agent.name }
      { name: 'OTEL_ENABLED', value: enableMonitoring ? 'true' : 'false' }
    ], sandboxEnv, backgroundAgentsEnv, agent.imageName == 'weave-planners' ? concat([
      { name: 'DATABASE_URL', secretRef: 'worker-database-url' }
    ], databricksEnv) : [], agent.imageName == 'weave-shuttle' ? fabricInternalEnv : [])
    appInsightsConnectionString: appInsights.outputs.connectionString
    deploymentEnvironment: envName
  }
}]

// =============================================================================
// Container Apps - MCP STDIO Wrapper (Standalone)
// =============================================================================
// Wraps STDIO-based MCP servers (e.g., Azure DevOps) with an HTTP API.
// Deployed as a standalone container app with external ingress so it's
// reachable from both the Temporal worker (within Azure) and the Vercel-hosted
// web app (external). Protected by API key auth (x-internal-api-key header).
// =============================================================================

module mcpStdioWrapperApp 'modules/container-app-sidecar.bicep' = {
  name: 'mcp-stdio-wrapper'
  dependsOn: [secrets]
  params: {
    name: '${resourcePrefix}-mcp-stdio-wrapper'
    location: location
    containerEnvId: containerEnv.id
    registryName: containerRegistry.name
    registryServer: containerRegistry.properties.loginServer
    managedIdentityId: managedIdentity.id
    image: '${containerRegistry.properties.loginServer}/fabric/mcp-stdio-wrapper:${resolvedMcpWrapperTag}'
    targetPort: 3100
    enableIngress: true
    cpu: '0.5'
    memory: '1Gi'
    // Keep at least 1 replica to avoid cold start killing STDIO process pool
    minReplicas: 1
    maxReplicas: envName == 'prod' ? 5 : 2
    secrets: [
      { name: 'mcp-wrapper-api-key', keyVaultUrl: '${kvBaseUrl}/mcp-wrapper-api-key', identity: managedIdentity.id }
    ]
    env: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '3100' }
      { name: 'MAX_PROCESSES', value: '50' }
      { name: 'IDLE_TTL_MS', value: '60000' }
      // API key for authentication (required for external access)
      { name: 'MCP_WRAPPER_API_KEY', secretRef: 'mcp-wrapper-api-key' }
      // OpenTelemetry configuration - sidecar handles routing to App Insights
      { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: 'grpc' }
      { name: 'OTEL_SERVICE_NAME', value: 'mcp-stdio-wrapper' }
      { name: 'OTEL_ENABLED', value: enableMonitoring ? 'true' : 'false' }
    ]
    appInsightsConnectionString: appInsights.outputs.connectionString
    deploymentEnvironment: envName
  }
}

// =============================================================================
// Monitoring & Alerting
// =============================================================================
//
// Architecture (also documented at top of modules/monitoring.bicep):
//
//   1. `monitoring` (always-on when enableMonitoring) owns the SINGLE
//      canonical Action Group plus the Container App availability
//      replica/restart alerts, LLM scheduled query alerts, and the
//      Application Insights scheduledQueryRules / metricAlerts that
//      replace the deleted self-hosted Prometheus + Alertmanager stack:
//      - HTTP 5xx burn-rate (SEV-1/SEV-2/SEV-3) via KQL on the `requests`
//        table — multi-window multi-burn-rate, App Insights Smart
//        Detection covers most other application anomalies.
//      - Custom-event alerts on `customEvents` for circuit-breaker open
//        transitions and consecutive synthetic-probe failures.
//      - `dependencies/failed` count alert for outbound integration
//        failures (api.openai.com, api.anthropic.com, etc.).
//      The Action Group's one webhookReceiver points at
//      ${ALERTS_WEBHOOK_URL} (the existing Power Automate flow).
//
// NON-NEGOTIABLE: no parallel Action Group, no separate Teams/Slack
// webhook resources, no internal adapter route. Every alert in the
// platform converges on the same Power Automate flow that the parent
// app-downtime feature uses. Application Insights replaces Prometheus +
// Alertmanager as the metrics + alerting backend — App Insights is
// already deployed by `application-insights.bicep` and the application
// services (api, temporal-worker, langgraph agents) emit metrics +
// custom events via `applicationinsights` SDK.
// =============================================================================

// -----------------------------------------------------------------------------
// Monitored container apps array — AUTO-DERIVED from the deployment config
// -----------------------------------------------------------------------------
// This block is purposely written to require ZERO edits when a new Container
// App is added. The monitored list is built by:
//
//   1. mapping every entry in `tsAgentConfigs` (the single source of truth
//      for TS / LangGraph agents) into a `{name, resourceId, critical}`
//      triple. Adding a new agent there automatically enrols it here.
//   2. appending the two standalone Container Apps that are NOT part of
//      `tsAgentConfigs` (temporal-worker + mcp-stdio-wrapper). These are
//      the only two `critical: true` apps (SEV-1 page on replica zero).
//
// Why are we still emitting one rule per app instead of a single multi-
// resource alert scoped at the resource group? Azure Monitor multi-resource
// metric alerts are currently supported only for VMs, SQL DBs / elastic
// pools, NetApp, Key Vault, Redis (deprecated), PostgreSQL Flexible,
// Recovery Services vaults, Operator Nexus families, and Data Collection
// Rules. `Microsoft.App/containerApps` is NOT on the supported list
// (https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#monitor-multiple-resources-with-one-alert-rule
// — table verified 2026-05). So one metric alert per (container app,
// metric) is still required, but the LIST is auto-derived from config
// instead of hand-maintained: a new app added to `tsAgentConfigs` is
// monitored automatically with no edits below this line.
// -----------------------------------------------------------------------------
// Each Container App's full resource ID can be reconstructed deterministically
// from its name within the current resource group via `resourceId(type, name)`.
// We do this instead of dereferencing module outputs because Bicep requires
// `for`-expression values inside a `var` to be calculable at deployment start
// (module `outputs` are not — see BCP182). The naming pattern matches the
// `name: '${resourcePrefix}-${agent.name}'` used in the `tsAgents` and
// standalone-app module declarations above.
var tsAgentMonitoredApps = [for agent in tsAgentConfigs: {
  name: agent.name
  resourceId: resourceId('Microsoft.App/containerApps', '${resourcePrefix}-${agent.name}')
  critical: false
}]

var standaloneMonitoredApps = [
  {
    name: 'temporal-worker'
    resourceId: resourceId('Microsoft.App/containerApps', '${resourcePrefix}-temporal-worker')
    critical: true
  }
  {
    name: 'mcp-stdio-wrapper'
    resourceId: resourceId('Microsoft.App/containerApps', '${resourcePrefix}-mcp-stdio-wrapper')
    critical: true
  }
]

var monitoredContainerApps = concat(standaloneMonitoredApps, tsAgentMonitoredApps)

module monitoring 'modules/monitoring.bicep' = if (enableMonitoring) {
  name: 'monitoring'
  // Explicit dependsOn so metric alerts are created AFTER the target apps.
  // (`monitoredContainerApps` uses `resourceId(...)` strings instead of
  // module-output references — see the auto-derivation block above for the
  // BCP182 reasoning — so Bicep would otherwise order this module ahead of
  // the apps it monitors.)
  dependsOn: [
    temporalWorker
    mcpStdioWrapperApp
    tsAgents
  ]
  params: {
    resourcePrefix: resourcePrefix
    location: location
    logAnalyticsWorkspaceId: logAnalytics.id
    containerEnvId: containerEnv.id
    environment: envName
    alertEmail: alertEmail
    alertsWebhookUrl: alertsWebhookUrl
    monitoredContainerApps: monitoredContainerApps
    appInsightsId: appInsights.outputs.id
  }
}

module dashboard 'modules/dashboard.bicep' = if (enableMonitoring) {
  name: 'dashboard'
  params: {
    resourcePrefix: resourcePrefix
    location: location
    logAnalyticsWorkspaceId: logAnalytics.id
    containerEnvId: containerEnv.id
  }
}

// =============================================================================
// Aspire Dashboard for OpenTelemetry Monitoring
// =============================================================================
// Provides real-time traces, metrics, and logs for all container apps
// Access via Azure Portal > Container Apps Environment > Aspire Dashboard
// =============================================================================

module aspireDashboard 'modules/aspire-dashboard.bicep' = if (enableMonitoring) {
  name: 'aspire-dashboard'
  params: {
    containerAppsEnvironmentName: containerEnv.name
  }
}

// =============================================================================
// DEPRECATED: Custom OTEL Collector and Jaeger
// =============================================================================
// These modules are no longer needed as Azure Container Apps provides a
// managed OpenTelemetry agent built into the environment.
// The managed agent automatically routes telemetry to the Aspire Dashboard
// via the openTelemetryConfiguration in the Container Apps Environment.
//
// If you need additional destinations (Jaeger, Prometheus, Application Insights),
// configure them in the openTelemetryConfiguration.destinationsConfiguration
// section of the Container Apps Environment resource above.
// =============================================================================

// DEPRECATED: Jaeger is no longer deployed as a separate container
// Use Application Insights or other managed services for trace storage
// module jaeger 'modules/jaeger.bicep' = if (false) { ... }

// DEPRECATED: Custom OTEL Collector is no longer needed
// Azure Container Apps provides a managed OpenTelemetry agent
// module otelCollector 'modules/otel-collector.bicep' = if (false) { ... }

// =============================================================================
// Governance guardrails (SOC 2 CC5.3 / CC7.1)
// =============================================================================
// The intended posture as Azure Policy, evaluated continuously — audit effect
// only, so it reports drift and never blocks a deploy.
//
// OFF by default and inert until an Owner grants the deploy identity a role
// permitting policyAssignments/write. The GitHub OIDC SP holds `Contributor`
// at subscription scope, whose notActions exclude `Microsoft.Authorization/*/
// Write`, so enabling this first would fail the deploy with AuthorizationFailed.
// The exact grant command is in modules/governance-policy.bicep.
module governancePolicy 'modules/governance-policy.bicep' = {
  name: 'governance-policy'
  params: {
    enablePolicyGuardrails: enablePolicyGuardrails
    location: location
  }
}

// =============================================================================
// Outputs
// =============================================================================

output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output containerEnvId string = containerEnv.id
output managedIdentityId string = managedIdentity.id
output keyVaultUri string = secrets.outputs.keyVaultUri
output temporalWorkerName string = temporalWorker.outputs.name
output mcpStdioWrapperUrl string = mcpStdioWrapperApp.outputs.url
output agentUrls array = [for (agent, i) in tsAgentConfigs: {
  name: agent.name
  url: tsAgents[i].outputs.url
}]
output monitoringEnabled bool = enableMonitoring
// DEPRECATED: multiDestinationOtlpEnabled - Azure Container Apps now uses managed OpenTelemetry agent
output multiDestinationOtlpEnabled bool = false
#disable-next-line BCP318
output aspireDashboardOtlpEndpoint string = enableMonitoring ? aspireDashboard.outputs.otlpEndpoint : ''
// DEPRECATED: otelCollectorEndpoint - No longer deployed, managed agent handles routing
output otelCollectorEndpoint string = ''
// DEPRECATED: jaegerUiUrl - No longer deployed, use Application Insights or external Jaeger service
output jaegerUiUrl string = ''

#disable-next-line BCP318
output actionGroupId string = enableMonitoring ? monitoring.outputs.actionGroupId : ''

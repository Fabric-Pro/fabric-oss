// =============================================================================
// Container App Module with OpenTelemetry Collector Sidecar
// =============================================================================
// Reusable module for deploying Azure Container Apps with OTel sidecar
// =============================================================================

@description('Name of the container app')
param name string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param containerEnvId string

@description('Container Registry name')
#disable-next-line no-unused-params
param registryName string

@description('Container Registry server')
param registryServer string

@description('Managed Identity ID for pulling images')
param managedIdentityId string

@description('Container image with tag')
param image string

@description('Target port for the container (0 for non-HTTP services)')
param targetPort int = 0

@description('Enable external ingress (automatically false when targetPort is 0)')
param enableIngress bool = false

@description('Browser origins allowed to call this app. Empty (the default) emits NO ingress corsPolicy, leaving the application\'s own CORS handling authoritative. Only set this for an app a browser calls directly and cross-origin.')
param allowedCorsOrigins array = []

@description('CPU allocation (e.g., 0.5, 1.0)')
param cpu string = '0.5'

@description('Memory allocation (e.g., 1Gi, 2Gi)')
param memory string = '1Gi'

@description('Minimum replicas')
param minReplicas int = 0

@description('Maximum replicas')
param maxReplicas int = 10

@description('Environment variables (supports both value and secretRef)')
param env array = []

@description('Secrets for the container (supports keyVaultUrl for Key Vault refs)')
param secrets array = []

@description('Application Insights connection string for OTel collector')
@secure()
param appInsightsConnectionString string

@description('Deployment environment (dev, prod)')
param deploymentEnvironment string = 'dev'

@description('Container name override (defaults to last segment of name)')
param containerName string = ''

@description('Additional sidecar containers (beyond the OTel collector)')
param additionalSidecars array = []

@description('Additional secrets for sidecars')
param additionalSidecarSecrets array = []

// =============================================================================
// OTel Collector Configuration
// =============================================================================

// Determine if this is an HTTP service
var isHttpService = targetPort > 0 && enableIngress

// Use provided containerName or extract from name
// For names like 'fabric-dev-document-generator', extract 'document-generator' (everything after 'fabric-<env>-')
// For names like 'fabric-dev-temporal-worker', extract 'temporal-worker'
var nameParts = split(name, '-')
// Skip first two parts (fabric-<env>-) and join the rest
var extractedName = length(nameParts) > 2 ? join(skip(nameParts, 2), '-') : last(nameParts)
var actualContainerName = containerName != '' ? containerName : extractedName

// Load otel collector config (Azure-specific)
// The standard config's azuremonitor exporter resolves the App Insights
// connection string at startup and the collector refuses to run without it —
// environments without App Insights get the debug-sink variant so
// the worker's OTLP endpoint stays live and the sidecar stays healthy.
var collectorConfigYaml = empty(appInsightsConnectionString)
  ? loadTextContent('../configs/otel-collector-azure-no-appinsights.yaml')
  : loadTextContent('../configs/otel-collector-azure.yaml')

// Transform secrets to Container Apps format
// Input: [{ name: 'x', keyVaultUrl: '...', identity: '...' }] or [{ name: 'x', value: '...' }]
var transformedSecrets = [for secret in secrets: secret.?keyVaultUrl != null ? {
  name: secret.name
  keyVaultUrl: secret.keyVaultUrl
  identity: secret.identity
} : {
  name: secret.name
  value: secret.value
}]

// Add otel-specific secrets. Container Apps rejects empty-valued secrets
// ("value or keyVaultUrl and identity should be provided"), so environments
// without Application Insights omit the secret entirely — the
// collector env var that references it is omitted in lock-step below.
var otelSecrets = concat(
  [
    {
      name: 'otel-config'
      value: collectorConfigYaml
    }
  ],
  empty(appInsightsConnectionString)
    ? []
    : [
        {
          name: 'appinsights-conn-string'
          value: appInsightsConnectionString
        }
      ]
)

// Transform additional sidecar secrets
var transformedSidecarSecrets = [for secret in additionalSidecarSecrets: secret.?keyVaultUrl != null ? {
  name: secret.name
  keyVaultUrl: secret.keyVaultUrl
  identity: secret.identity
} : {
  name: secret.name
  value: secret.value
}]

var allSecrets = concat(transformedSecrets, otelSecrets, transformedSidecarSecrets)

// Transform env vars - handle both value and secretRef
// Also add OTEL_EXPORTER_OTLP_ENDPOINT for sidecar communication
var transformedEnv = [for e in env: e.?secretRef != null ? {
  name: e.name
  secretRef: e.secretRef
} : {
  name: e.name
  value: e.value
}]

// Add OTEL endpoint pointing to sidecar
var otelEnv = [
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://localhost:4317' }
]

var allEnv = concat(transformedEnv, otelEnv)

// =============================================================================
// Container App
// =============================================================================

resource containerApp 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    environmentId: containerEnvId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: registryServer
          identity: managedIdentityId
        }
      ]
      secrets: allSecrets
      ingress: isHttpService ? {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        // Emitted ONLY when an app explicitly declares browser origins.
        //
        // This was `allowedOrigins: ['*']` unconditionally, which did not just
        // widen the boundary — it defeated the application's own CORS policy.
        // Container Apps enforces corsPolicy at the ingress proxy, in front of
        // the container, and answers the preflight itself. So a wildcard here
        // overrode agent-core's deliberate production fail-closed default
        // (`packages/agent-core/src/unified-server.ts`: origins default to `[]`
        // in production), on all 15 externally-reachable apps. The app-layer
        // guard was real but unreachable.
        //
        // These apps are called server-to-server (X-Agent-Key / Bearer), so no
        // browser depends on this. CORS is a browser-only control — removing it
        // cannot affect service-to-service traffic. With the policy absent, the
        // app decides, which is where the fail-closed logic already lives.
        //
        // SOC 2 CC6.6 / CC6.7 (register T5 — the Bicep half, which
        // `soc2-cors-failclosed` did not actually change despite the register
        // recording T5 as shipped).
        corsPolicy: empty(allowedCorsOrigins) ? null : {
          allowedOrigins: allowedCorsOrigins
          allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
          allowedHeaders: ['*']
        }
      } : null
    }
    template: {
      // Main container
      containers: concat([
        {
          name: actualContainerName
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: allEnv
          probes: isHttpService ? [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: targetPort
              }
              initialDelaySeconds: 30
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ] : []
        }
        {
          name: 'otel-collector'
          image: 'otel/opentelemetry-collector-contrib:0.115.1'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(
            // Omitted in lock-step with the secret above when the environment
            // has no Application Insights — a dangling secretRef fails
            // preflight validation.
            empty(appInsightsConnectionString)
              ? []
              : [
                  {
                    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
                    secretRef: 'appinsights-conn-string'
                  }
                ],
            [
              {
                name: 'DEPLOYMENT_ENVIRONMENT'
                value: deploymentEnvironment
              }
              {
                name: 'GOMEMLIMIT'
                value: '400MiB'
              }
            ]
          )
          volumeMounts: [
            {
              volumeName: 'otel-config-vol'
              mountPath: '/etc/otelcol'
            }
          ]
          command: [
            '/otelcol-contrib'
          ]
          args: [
            '--config=/etc/otelcol/config.yaml'
          ]
        }
      ], additionalSidecars)
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: isHttpService ? [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ] : []
      }
      volumes: [
        {
          name: 'otel-config-vol'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'otel-config'
              path: 'config.yaml'
            }
          ]
        }
      ]
    }
  }
}

// =============================================================================
// Outputs
// =============================================================================

output id string = containerApp.id
output name string = containerApp.name
output fqdn string = isHttpService ? containerApp.properties.configuration.ingress.fqdn : ''
output url string = isHttpService ? 'https://${containerApp.properties.configuration.ingress.fqdn}' : ''

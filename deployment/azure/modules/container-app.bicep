// =============================================================================
// Container App Module
// =============================================================================
// Reusable module for deploying Azure Container Apps
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

@description('Target port for the container')
param targetPort int

@description('Enable external ingress')
param enableIngress bool = true

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

// =============================================================================
// Container App
// =============================================================================

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

// Transform env vars - handle both value and secretRef
var transformedEnv = [for e in env: e.?secretRef != null ? {
  name: e.name
  secretRef: e.secretRef
} : {
  name: e.name
  value: e.value
}]

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: registryServer
          identity: managedIdentityId
        }
      ]
      secrets: transformedSecrets
      ingress: enableIngress ? {
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
        // Same opt-in shape as container-app-sidecar.bicep — see the rationale
        // there. Nothing deploys this module today (main.bicep uses the sidecar
        // module for all three app groups; only README.md still points here),
        // but it kept an unconditional `allowedOrigins: ['*']`, so anyone who
        // adopted it would silently reintroduce the wildcard that overrides the
        // application's own CORS. Fixed rather than left as a trap.
        corsPolicy: empty(allowedCorsOrigins) ? null : {
          allowedOrigins: allowedCorsOrigins
          allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
          allowedHeaders: ['*']
        }
      } : null
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: transformedEnv
          probes: enableIngress ? [
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
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: enableIngress ? [
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
    }
  }
}

// =============================================================================
// Outputs
// =============================================================================

output id string = containerApp.id
output name string = containerApp.name
output fqdn string = enableIngress ? containerApp.properties.configuration.ingress.fqdn : ''
output url string = enableIngress ? 'https://${containerApp.properties.configuration.ingress.fqdn}' : ''


// =============================================================================
// Jaeger Module for Azure Container Apps
// =============================================================================
// Deploys Jaeger all-in-one for distributed tracing storage and analysis
// Note: For production at scale, consider using Jaeger with external storage
// (Elasticsearch, Cassandra) or a managed service (Grafana Tempo, Honeycomb)
// =============================================================================

@description('Resource prefix for naming')
param resourcePrefix string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param containerEnvId string

@description('Managed Identity ID')
param managedIdentityId string

@description('Enable external access to Jaeger UI')
param enableExternalAccess bool = false

// =============================================================================
// Jaeger Container App
// =============================================================================

resource jaeger 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${resourcePrefix}-jaeger'
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
      ingress: {
        external: enableExternalAccess
        targetPort: 16686  // Jaeger UI
        transport: 'http'
        additionalPortMappings: [
          {
            external: false
            targetPort: 4317  // OTLP gRPC
          }
          {
            external: false
            targetPort: 4318  // OTLP HTTP
          }
          {
            external: false
            targetPort: 14268  // Jaeger Thrift
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'jaeger'
          image: 'jaegertracing/all-in-one:1.55'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'COLLECTOR_OTLP_ENABLED'
              value: 'true'
            }
            {
              name: 'SPAN_STORAGE_TYPE'
              value: 'badger'  // In-memory with persistence
            }
            {
              name: 'BADGER_EPHEMERAL'
              value: 'false'
            }
            {
              name: 'BADGER_DIRECTORY_VALUE'
              value: '/badger/data'
            }
            {
              name: 'BADGER_DIRECTORY_KEY'
              value: '/badger/key'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 14269
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 14269
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
          volumeMounts: [
            {
              volumeName: 'badger-data'
              mountPath: '/badger'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1  // Single instance for all-in-one
      }
      volumes: [
        {
          name: 'badger-data'
          // Note: EmptyDir storage is ephemeral - data is lost when container is rescheduled/revisioned.
          // This provides best-effort retention while replica stays up. For production durability,
          // consider using Azure Files storage mount or external storage (Elasticsearch, Cassandra).
          storageType: 'EmptyDir'
        }
      ]
    }
  }
}

// =============================================================================
// Outputs
// =============================================================================

output name string = jaeger.name
// DNS names within Container Apps Environment use the full container app name
output uiUrl string = enableExternalAccess ? 'https://${jaeger.properties.configuration.ingress.fqdn}' : 'http://${resourcePrefix}-jaeger:16686'
output otlpGrpcEndpoint string = '${resourcePrefix}-jaeger:4317'
output otlpHttpEndpoint string = '${resourcePrefix}-jaeger:4318'

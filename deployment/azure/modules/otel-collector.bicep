// =============================================================================
// OpenTelemetry Collector Module for Azure Container Apps
// =============================================================================
// Deploys a shared OTEL Collector that receives telemetry from all services
// and fans out to multiple destinations:
// - Aspire Dashboard (real-time debugging)
// - Jaeger (distributed tracing)
// - Prometheus endpoint (for Grafana metrics)
// =============================================================================

@description('Resource prefix for naming')
param resourcePrefix string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param containerEnvId string

@description('Container Registry server')
param registryServer string

@description('Image tag')
param imageTag string = 'latest'

@description('Managed Identity ID')
param managedIdentityId string

@description('Aspire Dashboard OTLP endpoint')
param aspireDashboardEndpoint string = 'aspire-dashboard:18889'

@description('Jaeger OTLP endpoint')
param jaegerEndpoint string = 'jaeger:4317'

@description('Environment name')
param environment string = 'production'

// =============================================================================
// OTEL Collector Container App
// =============================================================================

resource otelCollector 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${resourcePrefix}-otel-collector'
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
      ingress: {
        external: false
        targetPort: 4317
        transport: 'http2'  // gRPC requires HTTP/2
        additionalPortMappings: [
          {
            external: false
            targetPort: 4318  // OTLP HTTP
          }
          {
            external: false
            targetPort: 8889  // Prometheus metrics
          }
          {
            external: false
            targetPort: 13133  // Health check
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'otel-collector'
          // Custom image with config baked in (built from monitoring/otel-collector/Dockerfile)
          image: '${registryServer}/fabric/otel-collector:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'ASPIRE_DASHBOARD_ENDPOINT'
              value: aspireDashboardEndpoint
            }
            {
              name: 'JAEGER_ENDPOINT'
              value: jaegerEndpoint
            }
            {
              name: 'ENVIRONMENT'
              value: environment
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 13133
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 13133
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'cpu-scaling'
            custom: {
              type: 'cpu'
              metadata: {
                type: 'Utilization'
                value: '70'
              }
            }
          }
        ]
      }
    }
  }
}

// =============================================================================
// Outputs
// =============================================================================

output name string = otelCollector.name
// DNS names within Container Apps Environment use the full container app name
output grpcEndpoint string = '${resourcePrefix}-otel-collector:4317'
output httpEndpoint string = '${resourcePrefix}-otel-collector:4318'
output prometheusEndpoint string = '${resourcePrefix}-otel-collector:8889'

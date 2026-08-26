// =============================================================================
// Aspire Dashboard Module for Azure Container Apps
// =============================================================================
// Enables the built-in .NET Aspire Dashboard on the Container Apps Environment
// The dashboard provides real-time monitoring via OpenTelemetry (traces, metrics, logs)
// =============================================================================

@description('Container Apps Environment name')
param containerAppsEnvironmentName string

// =============================================================================
// Reference existing Container Apps Environment
// =============================================================================

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

// =============================================================================
// Aspire Dashboard Component
// =============================================================================
// This creates a managed Aspire Dashboard that:
// - Automatically collects OTLP telemetry from all apps in the environment
// - Provides a web UI for viewing traces, logs, and metrics
// - Uses Azure AD authentication for secure access
// =============================================================================

resource aspireDashboard 'Microsoft.App/managedEnvironments/dotNetComponents@2024-02-02-preview' = {
  name: 'aspire-dashboard'
  parent: containerAppsEnvironment
  properties: {
    componentType: 'AspireDashboard'
  }
}

// =============================================================================
// Outputs
// =============================================================================

output dashboardName string = aspireDashboard.name
output otlpEndpoint string = 'http://aspire-dashboard:18889'

// =============================================================================
// Application Insights Module for Azure Container Apps
// =============================================================================
// Deploys Application Insights for centralized telemetry (traces, logs, metrics)
// Free tier provides: 5GB/month data ingestion, 90-day retention
// =============================================================================

@description('Resource prefix for naming')
param resourcePrefix string

@description('Azure region')
param location string

@description('Log Analytics Workspace ID')
param logAnalyticsWorkspaceId string

@description('Tags for resources')
param tags object = {}

// =============================================================================
// Application Insights
// =============================================================================

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${resourcePrefix}-appinsights'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// =============================================================================
// Outputs
// =============================================================================

output name string = appInsights.name
output id string = appInsights.id
output instrumentationKey string = appInsights.properties.InstrumentationKey
output connectionString string = appInsights.properties.ConnectionString

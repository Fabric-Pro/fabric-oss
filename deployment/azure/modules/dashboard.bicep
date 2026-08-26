// =============================================================================
// Azure Dashboard Module for Container Apps Monitoring
// =============================================================================

@description('Resource prefix for naming')
param resourcePrefix string

@description('Azure region')
param location string

@description('Log Analytics Workspace ID')
#disable-next-line no-unused-params
param logAnalyticsWorkspaceId string

@description('Container Apps Environment ID')
param containerEnvId string

// =============================================================================
// Dashboard
// =============================================================================

resource dashboard 'Microsoft.Portal/dashboards@2020-09-01-preview' = {
  name: '${resourcePrefix}-dashboard'
  location: location
  tags: {
    'hidden-title': 'Fabric Container Apps Dashboard'
  }
  properties: {
    lenses: [
      {
        order: 0
        parts: [
          {
            position: { x: 0, y: 0, colSpan: 6, rowSpan: 4 }
            metadata: {
              #disable-next-line BCP036
              type: 'Extension/HubsExtension/PartType/MonitorChartPart'
              inputs: [
                {
                  name: 'options'
                  value: {
                    chart: {
                      title: 'CPU Usage'
                      metrics: [
                        {
                          resourceMetadata: { id: containerEnvId }
                          name: 'UsageNanoCores'
                          aggregationType: 4
                        }
                      ]
                      visualization: { chartType: 2 }
                      timespan: { relative: { duration: 3600000 } }
                    }
                  }
                }
              ]
            }
          }
          {
            position: { x: 6, y: 0, colSpan: 6, rowSpan: 4 }
            metadata: {
              #disable-next-line BCP036
              type: 'Extension/HubsExtension/PartType/MonitorChartPart'
              inputs: [
                {
                  name: 'options'
                  value: {
                    chart: {
                      title: 'Memory Usage'
                      metrics: [
                        {
                          resourceMetadata: { id: containerEnvId }
                          name: 'WorkingSetBytes'
                          aggregationType: 4
                        }
                      ]
                      visualization: { chartType: 2 }
                      timespan: { relative: { duration: 3600000 } }
                    }
                  }
                }
              ]
            }
          }
          {
            position: { x: 0, y: 4, colSpan: 6, rowSpan: 4 }
            metadata: {
              #disable-next-line BCP036
              type: 'Extension/HubsExtension/PartType/MonitorChartPart'
              inputs: [
                {
                  name: 'options'
                  value: {
                    chart: {
                      title: 'Replica Count'
                      metrics: [
                        {
                          resourceMetadata: { id: containerEnvId }
                          name: 'Replicas'
                          aggregationType: 3
                        }
                      ]
                      visualization: { chartType: 2 }
                      timespan: { relative: { duration: 3600000 } }
                    }
                  }
                }
              ]
            }
          }
          {
            position: { x: 6, y: 4, colSpan: 6, rowSpan: 4 }
            metadata: {
              #disable-next-line BCP036
              type: 'Extension/HubsExtension/PartType/MonitorChartPart'
              inputs: [
                {
                  name: 'options'
                  value: {
                    chart: {
                      title: 'Requests'
                      metrics: [
                        {
                          resourceMetadata: { id: containerEnvId }
                          name: 'Requests'
                          aggregationType: 1
                        }
                      ]
                      visualization: { chartType: 2 }
                      timespan: { relative: { duration: 3600000 } }
                    }
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  }
}

// =============================================================================
// Outputs
// =============================================================================

output dashboardId string = dashboard.id
output dashboardName string = dashboard.name


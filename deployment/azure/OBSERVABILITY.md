# Observability Architecture

## Local Development

**Uses Aspire Dashboard** (configured via docker-compose or local setup)

- Traces, logs, and metrics sent to `http://aspire-dashboard:18889` via OTLP
- Dashboard UI accessible at `http://localhost:18888`
- Configuration: `OTEL_EXPORTER_OTLP_ENDPOINT` in local environment

✅ **Status**: Working correctly (no changes needed)

## Dev/Production (Azure Container Apps)

**Uses Application Insights** (Azure-managed APM)

- Traces and logs sent via managed OpenTelemetry agent
- Free tier: 5GB/month data ingestion, 90-day retention
- UI: Azure Portal → Application Insights → Transaction search, Application map, Live metrics

### How it works:

```
┌─────────────────┐
│  Containers     │ (OTEL SDK instrumented)
│  - temporal     │
│  - web          │
│  - agents       │
└─────────────────┘
        ↓ (auto-injected OTEL_EXPORTER_OTLP_ENDPOINT)
┌──────────────────────────────────┐
│  Managed OTLP Agent              │ (Azure-managed)
│  - Auto-configured               │
│  - Routes to App Insights        │
└──────────────────────────────────┘
        ↓
┌──────────────────────────────────┐
│  Application Insights            │
│  - Traces (distributed tracing)  │
│  - Logs (structured logs)        │
│  - Metrics (via SDK)             │
└──────────────────────────────────┘
```

### Configuration

In `deployment/azure/main.bicep`:

```bicep
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  properties: {
    // Application Insights connection
    appInsightsConfiguration: {
      connectionString: appInsights.outputs.connectionString
    }
    // Managed agent routes OTLP to App Insights
    openTelemetryConfiguration: {
      tracesConfiguration: {
        destinations: ['appInsights']
      }
      logsConfiguration: {
        destinations: ['appInsights']
      }
    }
  }
}
```

### Accessing Telemetry

**Azure Portal:**
1. Navigate to Application Insights resource (`fabric-{env}-appinsights`)
2. **Transaction search**: View individual traces
3. **Application map**: Visualize service dependencies
4. **Live Metrics**: Real-time telemetry stream
5. **Failures**: Error analysis and stack traces
6. **Performance**: Slow requests and bottlenecks

**Query with KQL:**
```kusto
// Find traces for temporal worker
traces
| where cloud_RoleName == "temporal-worker"
| where timestamp > ago(1h)
| order by timestamp desc

// Find errors
exceptions
| where timestamp > ago(1h)
| project timestamp, type, outerMessage, cloud_RoleName
```

## Future Options (Code Preserved)

The following modules are available for future use if needed:

### Jaeger (`deployment/azure/modules/jaeger.bicep`)
- **Use case**: Alternative to Application Insights for self-hosted tracing
- **Requires**: External ingress enabled (publicly accessible HTTPS endpoint)
- **Cost**: Free (runs in Container Apps)
- **Note**: Managed OTLP agent only sends to external HTTPS endpoints

### Prometheus + Grafana
- **Use case**: Custom metrics dashboards
- **Configuration**: Apps expose `/metrics` endpoint, Prometheus scrapes them
- **Files**:
  - `monitoring/prometheus/prometheus.yml`
  - `monitoring/grafana/provisioning/datasources/prometheus.yml`
- **Deployment**: Run as container apps (not currently deployed)

### OTEL Collector (`deployment/azure/modules/otel-collector.bicep`)
- **Use case**: Fan-out telemetry to multiple destinations
- **Limitation**: Cannot be used as intermediate collector in Container Apps (DNS resolution issue)
- **Alternative**: Use managed OTLP agent instead

## Deployment

Application Insights is automatically deployed with the main infrastructure:

```bash
cd deployment/azure
az deployment group create \
  --resource-group <resource-group> \
  --template-file main.bicep \
  --parameters main.parameters.json
```

Application Insights resource name: `fabric-{env}-appinsights`

## Costs

**Application Insights Free Tier:**
- ✅ 5 GB/month data ingestion (plenty for dev/small production)
- ✅ 90-day data retention
- ✅ Basic analytics and queries
- ✅ No credit card required

**If you exceed free tier:**
- Pay-as-you-go: $2.30/GB after 5GB
- Can set daily cap to prevent overages

## Troubleshooting

### No traces appearing in Application Insights

1. **Check managed agent is configured:**
   ```bash
   az containerapp env show \
     --name <container-app-env> \
     --resource-group <resource-group> \
     --query properties.openTelemetryConfiguration
   ```

2. **Verify container has OTEL SDK:**
   - Check logs for "OpenTelemetry SDK started" message
   - Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is auto-injected (check container env vars)

3. **Check Application Insights connection:**
   - Verify `appInsightsConfiguration.connectionString` is set in Container Apps Environment
   - Check Application Insights → Live Metrics for real-time data

### Local development broken after changes

**Don't worry!** We kept all local development configuration:
- `OTEL_EXPORTER_OTLP_ENDPOINT` still set in local env files
- Aspire Dashboard still running in docker-compose
- No changes to application code

## References

- [Application Insights Overview](https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview)
- [OpenTelemetry in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/opentelemetry-agents)
- [Application Insights Transaction Search](https://learn.microsoft.com/en-us/azure/azure-monitor/app/transaction-search-and-diagnostics)

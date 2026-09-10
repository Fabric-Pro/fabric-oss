# Observability Architecture

## Local Development

**Uses Aspire Dashboard** (configured via docker-compose or local setup)

- Traces, logs, and metrics sent to `http://aspire-dashboard:18889` via OTLP
- Dashboard UI accessible at `http://localhost:18888`
- Configuration: `OTEL_EXPORTER_OTLP_ENDPOINT` in local environment

✅ **Status**: Working correctly (no changes needed)

## Dev/Production (Azure Container Apps)

**Uses Application Insights through per-replica OpenTelemetry sidecars**

- Application SDKs send traces, logs, and metrics to `localhost:4317`
- The `otel-collector` sidecar exports OTLP data to Application Insights
- The sidecar health endpoint is probed on `localhost:13133`
- Collector health/backpressure metrics are self-scraped from
  `127.0.0.1:8888` once per minute
- Free tier: 5GB/month data ingestion, 90-day retention
- UI: Azure Portal → Application Insights → Transaction search, Application map, Live metrics

### How it works:

```
┌─────────────────┐
│  App container  │ (OTEL SDK instrumented)
│  - temporal     │
│  - agents       │
│  - MCP wrapper  │
└─────────────────┘
        ↓ localhost:4317
┌──────────────────────────────────┐
│  otel-collector sidecar          │ (one per replica)
│  - Azure Monitor exporter        │
│  - / health probe on :13133      │
│  - bounded self-scrape on :8888  │
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

`deployment/azure/modules/container-app-sidecar.bicep` loads one of the
Azure collector configs into a secret-backed volume, points the application
at the sidecar, and gives both containers the same stable service identity:

```bicep
{ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://localhost:4317' }
{ name: 'OTEL_SERVICE_NAME', value: actualContainerName }
```

With an Application Insights connection string, the sidecar uses
`configs/otel-collector-azure.yaml`. Environments without one use
`configs/otel-collector-azure-no-appinsights.yaml`, which keeps OTLP and
health endpoints live with a sampled debug sink.

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
| where cloud_RoleName == "fabric.temporal-worker"
| where timestamp > ago(1h)
| order by timestamp desc

// Find errors
exceptions
| where timestamp > ago(1h)
| project timestamp, type, outerMessage, cloud_RoleName
```

Application-scoped queries use the classic aliases `requests`,
`dependencies`, `traces`, `customEvents`, and `customMetrics`. `AppTraces`
is a workspace-scoped alias and does not resolve through the Application
Insights query API used by the alert rules.

The collector self-scrape retains only uptime, exporter queue capacity/size,
send/enqueue failures, and receiver/processor refusal metrics. This selector
belongs to the Prometheus self receiver; it does not filter application or
Temporal metrics entering over OTLP. Native metrics such as
`temporal_worker_task_slots_available` and
`temporal_activity_schedule_to_start_latency` remain available for capacity
alerts. See [the alert catalogue](../../docs/monitoring/alerts.md) for the
queries and thresholds.

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

### Standalone OTEL Collector (`deployment/azure/modules/otel-collector.bicep`)
- **Use case**: Fan-out telemetry to multiple destinations
- **Status**: Not deployed. Azure Container Apps use the per-replica sidecar
  in `container-app-sidecar.bicep` instead.

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

1. **Check the sidecar is healthy:**
   ```bash
   az containerapp revision show \
     --revision <revision-name> \
     --resource-group <resource-group> \
     --query 'properties.template.containers[?name==`otel-collector`].probes'
   ```

2. **Verify container has OTEL SDK:**
   - Check logs for "OpenTelemetry SDK started" message
   - Verify `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`
   - Verify the app and sidecar share the expected `OTEL_SERVICE_NAME`

3. **Check Application Insights connection:**
   - Verify the sidecar has an `APPLICATIONINSIGHTS_CONNECTION_STRING`
     secret reference
   - Check Application Insights → Live Metrics for real-time data

4. **Check the independent pipeline-failure path:**
   - Query `ContainerAppConsoleLogs_CL` for `ContainerName_s ==
     "otel-collector"` and messages such as `Exporting failed`, `Dropping
     data`, `Rejecting data`, `sending queue is full`, or `Failed to process`
   - The `${prefix}-otel-collector-pipeline-failures` rule uses this
     independently captured path for processing, rejection, queue, and drop
     failures
   - The pinned Azure exporter reports asynchronous network transmission
     failures only at debug level. Production stays at info to bound log
     volume; `${prefix}-otel-collector-heartbeat-missing` is the sustained
     Azure transport-outage signal because uptime stops reaching Application
     Insights

### Local development broken after changes

**Don't worry!** We kept all local development configuration:
- `OTEL_EXPORTER_OTLP_ENDPOINT` still set in local env files
- Aspire Dashboard still running in docker-compose
- No changes to application code

## References

- [Application Insights Overview](https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview)
- [OpenTelemetry in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/opentelemetry-agents)
- [Application Insights Transaction Search](https://learn.microsoft.com/en-us/azure/azure-monitor/app/transaction-search-and-diagnostics)

// =============================================================================
// Azure Monitor & Alerting Module
// =============================================================================
// AUTO-DISCOVERY DESIGN
// ---------------------------------------------------------------------------
// The `monitoredContainerApps` array passed in by `main.bicep` is auto-
// derived from the platform's Container App config (`tsAgentConfigs` plus
// two standalone apps — temporal-worker + mcp-stdio-wrapper). When a new
// Container App is added upstream — for example, a new TS / LangGraph
// agent appended to `tsAgentConfigs` — it is automatically enrolled here
// with NO edits to this module.
//
// Why are we still emitting one replica + one restart metric alert per
// app instead of a single multi-resource rule scoped at the resource
// group? Azure Monitor's multi-resource metric alert feature is currently
// supported only for VMs, SQL DBs / elastic pools, NetApp, Key Vault,
// Redis, PostgreSQL Flexible, Recovery Services vaults, Operator Nexus
// resources, and Data Collection Rules. `Microsoft.App/containerApps`
// is NOT on the supported list — verified at
// https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#monitor-multiple-resources-with-one-alert-rule
// (table reviewed 2026-05). So the `[for app in monitoredContainerApps:
// ...]` loops below remain per-app for now.
//
// MIGRATION SKETCH (apply when Azure adds containerApps to the supported
// list — collapses 2N rules into 2):
//
//   resource replicasMultiResAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
//     name: '${resourcePrefix}-replicas-zero-multi'
//     location: 'global'
//     properties: {
//       severity: 2
//       enabled: true
//       scopes: [ resourceGroup().id ]
//       targetResourceType: 'Microsoft.App/containerApps'
//       targetResourceRegion: location
//       evaluationFrequency: 'PT5M'
//       windowSize: 'PT5M'
//       criteria: {
//         'odata.type': 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria'
//         allOf: [{
//           name: 'ReplicaCountZero'
//           metricName: 'Replicas'
//           metricNamespace: 'Microsoft.App/containerApps'
//           operator: 'LessThanOrEqual'
//           threshold: 0
//           timeAggregation: 'Maximum'
//           criterionType: 'StaticThresholdCriterion'
//         }]
//       }
//       actions: [{ actionGroupId: actionGroup.id }]
//       autoMitigate: false
//     }
//   }
//
// Keep the per-app SEV-1 rule for `temporal-worker` as a separate
// exception even in the multi-resource future (we want it routed at
// higher severity than the rest of the RG).
// ---------------------------------------------------------------------------
//
// This module owns the SINGLE, CANONICAL `actionGroup` resource for the entire
// platform. The Action Group's one webhookReceiver posts to the existing
// Power Automate flow at ${alertsWebhookUrl}. There is NO parallel
// notification path and NO internal adapter route anywhere in the
// deployment.
//
// End-to-end alert flow for ALL alerts (replica/restart, LLM, error-rate
// burn-rate, integration outage, dependency failure):
//
//   [Azure Monitor metric alert / scheduledQueryRule fires]
//     -> [This Action Group's `actions[]` -> webhookReceiver `AlertsWorkflow`]
//     -> [POST ${alertsWebhookUrl} — Azure Common Alert Schema (CAS) payload]
//     -> [Power Automate flow fans out to Teams + Slack + email]
//
// Application Insights replaces the previously deployed Prometheus +
// Alertmanager stack as the metrics + alerting backend for error-rate
// burn-rate, circuit-breaker, synthetic-probe, and dependency failure
// rules. App Insights Smart Detection (auto-enabled, no rule needed)
// provides anomaly detection across application error rate, response
// time, and dependency failures — covering the "general anomaly"
// surface area without requiring hand-tuned thresholds.
//
// VERIFICATION: a Teams card from a new SEV-2 alert (e.g.,
// CircuitBreakerOpened) MUST land in the same Teams channel as a
// replica-zero availability alert. Both paths converge on the same
// Power Automate flow. The flow handles the single CAS payload shape —
// no Alertmanager-native parsing required.
// =============================================================================

@description('Resource prefix for naming')
param resourcePrefix string

@description('Azure region')
#disable-next-line no-unused-params
param location string

@description('Log Analytics Workspace ID — required to deploy repo-integration health alert rules (which query ContainerAppConsoleLogs_CL)')
param logAnalyticsWorkspaceId string

@description('Container Apps Environment ID')
#disable-next-line no-unused-params
param containerEnvId string

@description('Environment name')
#disable-next-line no-unused-params
param environment string

@description('Alert notification email')
param alertEmail string = ''

@description('Power Automate workflow webhook URL for alert notifications (posts to Teams and Slack)')
@secure()
param alertsWebhookUrl string = ''

@description('Array of container apps to monitor: { name: string, resourceId: string, critical: bool }')
param monitoredContainerApps array = []

@description('Application Insights resource ID — required to deploy LLM alert rules')
param appInsightsId string = ''

// The sidecar's collector-only resource processor sets each app's service.name and the Azure
// exporter combines it with service.namespace (`fabric`) as cloud_RoleName.
// Keep this derived from the same input as replica monitoring so a newly-added
// app automatically joins collector heartbeat coverage.
var expectedTelemetryRoles = [for app in monitoredContainerApps: 'fabric.${app.name}']

// =============================================================================
// Action Group for Alerts
// =============================================================================

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${resourcePrefix}-alerts-ag'
  location: 'global'
  properties: {
    groupShortName: 'FabricAlert'
    enabled: true
    emailReceivers: alertEmail != '' ? [
      {
        name: 'AdminEmail'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ] : []
    webhookReceivers: alertsWebhookUrl != '' ? [
      {
        name: 'AlertsWorkflow'
        serviceUri: alertsWebhookUrl
        useCommonAlertSchema: true
      }
    ] : []
  }
}

// =============================================================================
// Replica Count Alert Rules (Downtime Detection)
// =============================================================================
// Detects when a container app has 0 running replicas (service is down).
// Uses Maximum aggregation so the alert does not fire during scale-up events.
// =============================================================================

resource replicaAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for app in monitoredContainerApps: {
  name: '${resourcePrefix}-${app.name}-replica-alert'
  location: 'global'
  properties: {
    description: '${app.name} has 0 running replicas - service is down'
    severity: app.critical ? 1 : 2
    enabled: true
    scopes: [app.resourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ReplicaCountZero'
          metricName: 'Replicas'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'LessThanOrEqual'
          threshold: 0
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
    autoMitigate: false
  }
}]

// =============================================================================
// Crash-Loop Alert Rules (Instability Detection)
// =============================================================================
// Detects when a container app is crash-looping (more than 5 restarts in 5 min).
// Severity is always 2 (Warning) regardless of criticality.
// =============================================================================

resource restartAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for app in monitoredContainerApps: {
  name: '${resourcePrefix}-${app.name}-restart-alert'
  location: 'global'
  properties: {
    description: '${app.name} is crash-looping - more than 5 restarts in 5 minutes'
    severity: 2
    enabled: true
    scopes: [app.resourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HighRestartCount'
          metricName: 'RestartCount'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
    autoMitigate: false
  }
}]

// =============================================================================
// LLM Usage Alert Rules (AI Monitoring via Application Insights)
// =============================================================================
// Queries the `dependencies` table where LLM spans land (SpanKind.INTERNAL →
// type = "InProc"). Span names follow the pattern "llm.<operation>".
// Only deployed when appInsightsId is provided.
// =============================================================================

resource llmHighErrorRateAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-llm-high-error-rate'
  location: location
  properties: {
    displayName: 'AI - High LLM Error Rate (>10%)'
    description: 'LLM error rate exceeded 10% over the last 5 minutes — possible provider outage or bug'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            let total = toscalar(union dependencies, requests | where timestamp > ago(5m) | where name startswith "llm." | count);
            let errors = toscalar(union dependencies, requests | where timestamp > ago(5m) | where name startswith "llm." | where success == false | count);
            print error_rate_pct = iff(total > 0, (toreal(errors) / toreal(total)) * 100.0, 0.0)
            | where error_rate_pct > 10
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: false
  }
}

resource llmProviderErrorRateAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-llm-provider-error-rate'
  location: location
  properties: {
    displayName: 'AI - LLM Provider Error Rate (>25%)'
    description: 'A specific LLM provider error rate exceeded 25% — possible provider-specific outage'
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            union dependencies, requests
            | where timestamp > ago(5m)
            | where name startswith "llm."
            | summarize total = count(), errors = countif(success == false)
              by provider = tostring(customDimensions["gen_ai.system"])
            | where isnotempty(provider)
            | extend error_rate_pct = iff(total > 0, (toreal(errors) / toreal(total)) * 100.0, 0.0)
            | where error_rate_pct > 25
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: false
  }
}

resource llmHighLatencyAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-llm-high-latency'
  location: location
  properties: {
    displayName: 'AI - High LLM Latency P95 (>30s)'
    description: 'P95 LLM request latency exceeded 30 seconds for at least one provider'
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            union dependencies, requests
            | where timestamp > ago(5m)
            | where name startswith "llm."
            | summarize p95_ms = percentile(duration, 95)
              by provider = tostring(customDimensions["gen_ai.system"])
            | where p95_ms > 30000
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: false
  }
}

resource llmTokenUsageSpikeAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-llm-token-usage-spike'
  location: location
  properties: {
    displayName: 'AI - Token Usage Spike (>5x hourly average)'
    description: 'Token usage in the last 5 minutes is more than 5x the hourly average — possible runaway agent or abuse'
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            let bins = union dependencies, requests
                | where timestamp > ago(1h)
                | where name startswith "llm."
                | extend total_tokens = toint(customDimensions["gen_ai.usage.input_tokens"]) + toint(customDimensions["gen_ai.usage.output_tokens"])
                | summarize tokens = sum(total_tokens) by bin(timestamp, 5m);
            let recent = toscalar(bins | top 1 by timestamp desc | project tokens);
            let hist_avg = toscalar(bins | summarize avg(tokens));
            print ratio = toreal(recent) / max_of(toreal(hist_avg), 1.0)
            | where ratio > 5
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: false
  }
}

resource llmHighOutputTokenRateAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-llm-high-output-token-rate'
  location: location
  properties: {
    displayName: 'AI - High Output Token Rate (>5000/s per model)'
    description: 'Output token rate for a model/provider exceeded 5000 tokens per second — possible runaway generation'
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            union dependencies, requests
            | where timestamp > ago(5m)
            | where name startswith "llm."
            | summarize output_tokens = sum(toint(customDimensions["gen_ai.usage.output_tokens"]))
              by provider = tostring(customDimensions["gen_ai.system"]),
                 model = tostring(customDimensions["gen_ai.request.model"])
            | where isnotempty(provider)
            | extend output_per_sec = toreal(output_tokens) / 300.0
            | where output_per_sec > 5000
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: false
  }
}

resource llmSignalCoverageAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  // Preserve the deployed resource identity. Azure incremental deployment does
  // not delete a renamed scheduledQueryRule, which would leave the obsolete
  // silence-after-activity rule enabled beside this signal-coverage behavior.
  name: '${resourcePrefix}-llm-no-requests'
  location: location
  properties: {
    displayName: 'AI - LLM Trace Signal Missing After Requests'
    description: 'LLM request metrics increased in the last 15 minutes but no matching llm.* spans arrived for that service — the trace signal is broken. Idle services do not alert.'
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: '''
            // llm.requests is a cumulative counter. Compare the most recent
            // 15m with a preceding baseline per process/attribute series; a
            // reset contributes its new value instead of a negative delta.
            let attempts = customMetrics
              | where timestamp > ago(30m) and name == "llm.requests"
              | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                       instance = tostring(customDimensions["service.instance.id"]),
                       provider = tostring(customDimensions["provider"]),
                       model = tostring(customDimensions["model"]),
                       operation = tostring(customDimensions["operation"]),
                       status = tostring(customDimensions["status"])
              | summarize baseline = maxif(value, timestamp between (ago(30m) .. ago(15m))),
                          recent = maxif(value, timestamp > ago(15m)),
                          recent_points = countif(timestamp > ago(15m))
                by role, instance, provider, model, operation, status
              | where recent_points > 0
              | extend delta = iff(isnull(baseline) or recent < baseline, recent, recent - baseline)
              | summarize attempts = sum(delta) by role
              | where attempts > 0;
            let traced = union dependencies, requests
              | where timestamp > ago(15m) and name startswith "llm."
              | extend role = tolower(coalesce(cloud_RoleName, "unknown"))
              | summarize spans = count() by role;
            attempts
            | join kind=leftouter traced on role
            | extend spans = coalesce(spans, 0)
            | where spans == 0
            | project role, attempts, spans
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: false
  }
}

// =============================================================================
// Application Insights — Error-Rate Burn-Rate Alert Rules
// =============================================================================
// Replaces the burn-rate PromQL rules from the deleted self-hosted stack.
// Three scheduledQueryRules, one per severity, all driven by KQL against the
// auto-instrumented `requests` table.
//
// Smart Detection is also auto-enabled by App Insights and covers many of
// the same anomalies without explicit rules — these rules exist to enforce
// the multi-window multi-burn-rate convention from the spec.
// =============================================================================

// -----------------------------------------------------------------------------
// Security alert (SOC 2 CC7.2 -- register L5): Key Vault unauthorized access
// -----------------------------------------------------------------------------
// Fires when one caller racks up >= 5 Key Vault *authorization denials* (HTTP
// 403 Forbidden) in 15 min -- an authenticated principal repeatedly refused a
// secret/key by RBAC / access policy / network ACL, i.e. a possible secret-
// access attack or a broken identity binding. KV AuditEvents reach this
// workspace via the diagnostic setting in main.bicep (PR #1881); reuses the
// single canonical action group.
//
// We key on 403 ONLY, NOT `httpStatusCode_d >= 400`: every Key Vault data-plane
// call BEGINS with an unauthenticated probe that Azure AD answers with a benign
// HTTP 401 (`OperationName == "Authentication"`, `ResultSignature ==
// "Unauthorized"`, empty identity) before the client retries with a bearer
// token and succeeds. Those 401 challenges are the normal first leg of the
// OAuth handshake -- one per token acquisition -- so `>= 400` counted the
// handshake itself as an attack and paged SEV-1 every ~15 min with zero real
// denials (verified against fabric-dev on 2026-07-04: 0x 403 vs 450x 401 over
// 24h, against ~10k successful SecretGets). 403 is the true CC7.2 signal.
resource kvUnauthorizedAccessAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (logAnalyticsWorkspaceId != '') {
  name: '${resourcePrefix}-kv-unauthorized-access'
  location: location
  properties: {
    displayName: 'Security - Key Vault Unauthorized Access Attempts'
    description: 'SOC 2 CC7.2 -- >= 5 Key Vault authorization denials (HTTP 403 Forbidden) from one caller in 15 min (possible secret-access attack or misconfiguration). Excludes the benign 401 Azure AD pre-auth challenge.'
    severity: 1
    enabled: true
    scopes: [logAnalyticsWorkspaceId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where TimeGenerated > ago(15m)
            | where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"
            // 403 = a genuine authorization denial. 401 is the benign AAD
            // pre-auth challenge that precedes every successful call -- exclude it.
            | where httpStatusCode_d == 403
            | summarize failures = count() by CallerIPAddress
            | where failures >= 5
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
    // Transient sliding-window burst counter: self-resolve once the denial
    // spike subsides so a later spike re-notifies (vs. the persistent-state
    // rules above, which stay open until the underlying condition clears).
    autoMitigate: true
  }
}

resource httpErrorBurnRateSev1Alert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-http-5xx-burn-rate-sev1'
  location: location
  properties: {
    displayName: 'App - HTTP 5xx Burn Rate SEV-1 (14.4x over 5m and 1h)'
    description: 'HTTP 5xx error rate is burning the monthly SLO budget at 14.4x the sustainable rate over BOTH the 5m and 1h windows — page on-call. Routes through ${alertsWebhookUrl}. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#http-5xx-burn-rate-kql-scheduledqueryrules'
    severity: 0
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            let slo_target = 0.999;
            let burn_multiplier = 14.4;
            let threshold = (1.0 - slo_target) * burn_multiplier;
            let request_base = requests
              | where timestamp > ago(1h)
              | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                       path = tolower(coalesce(tostring(parse_url(url).Path), "<application>")),
                       weight = tolong(coalesce(itemCount, 1)),
                       status_code = toint(resultCode)
              // Match the application-side probe filter exactly: exclude only
              // these path roots (and their children), never names such as
              // /healthcare or /metrics-report.
              | where not(path matches regex @"^/(?:api/)?(?:healthz?|readyz?|livez?|metrics)(?:/|$)");
            let short_window = request_base
              | where timestamp > ago(5m)
              | summarize short_total = sum(weight), short_errors = sumif(weight, status_code between (500 .. 599)) by role;
            let long_window = request_base
              | summarize long_total = sum(weight), long_errors = sumif(weight, status_code between (500 .. 599)) by role;
            short_window
            | join kind=inner long_window on role
            | extend short_rate = iff(short_total > 0, toreal(short_errors) / toreal(short_total), 0.0)
            | extend long_rate = iff(long_total > 0, toreal(long_errors) / toreal(long_total), 0.0)
            | where short_rate > threshold and long_rate > threshold and long_total > 10
            | project role, short_rate, long_rate, short_total, long_total, short_errors, long_errors
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#http-5xx-burn-rate-kql-scheduledqueryrules'
        severity: 'SEV-1'
      }
    }
    autoMitigate: false
  }
}

resource httpErrorBurnRateSev2Alert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-http-5xx-burn-rate-sev2'
  location: location
  properties: {
    displayName: 'App - HTTP 5xx Burn Rate SEV-2 (6x over 30m and 6h)'
    description: 'HTTP 5xx error rate is burning the monthly SLO budget at 6x the sustainable rate over BOTH the 30m and 6h windows — open ticket, respond within business hours. Routes through ${alertsWebhookUrl}. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#http-5xx-burn-rate-kql-scheduledqueryrules'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT6H'
    criteria: {
      allOf: [
        {
          query: '''
            let slo_target = 0.999;
            let burn_multiplier = 6.0;
            let threshold = (1.0 - slo_target) * burn_multiplier;
            let request_base = requests
              | where timestamp > ago(6h)
              | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                       path = tolower(coalesce(tostring(parse_url(url).Path), "<application>")),
                       weight = tolong(coalesce(itemCount, 1)),
                       status_code = toint(resultCode)
              | where not(path matches regex @"^/(?:api/)?(?:healthz?|readyz?|livez?|metrics)(?:/|$)");
            let short_window = request_base
              | where timestamp > ago(30m)
              | summarize short_total = sum(weight), short_errors = sumif(weight, status_code between (500 .. 599)) by role;
            let long_window = request_base
              | summarize long_total = sum(weight), long_errors = sumif(weight, status_code between (500 .. 599)) by role;
            short_window
            | join kind=inner long_window on role
            | extend short_rate = iff(short_total > 0, toreal(short_errors) / toreal(short_total), 0.0)
            | extend long_rate = iff(long_total > 0, toreal(long_errors) / toreal(long_total), 0.0)
            | where short_rate > threshold and long_rate > threshold and long_total > 30
            | project role, short_rate, long_rate, short_total, long_total, short_errors, long_errors
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#http-5xx-burn-rate-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: false
  }
}

resource httpErrorBurnRateSev3Alert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-http-5xx-burn-rate-sev3'
  location: location
  properties: {
    displayName: 'App - HTTP 5xx Burn Rate SEV-3 (1x over 6h and 2d)'
    description: 'HTTP 5xx error rate is burning the monthly SLO budget at the sustained baseline rate over BOTH the 6h and 2d windows — SEV-3 ticket-only, surfaces in the weekly digest. Note: long window capped at Azure scheduledQueryRules max (P2D = 48h). Routes through ${alertsWebhookUrl}. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#http-5xx-burn-rate-kql-scheduledqueryrules'
    severity: 3
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT1H'
    windowSize: 'P2D'
    criteria: {
      allOf: [
        {
          query: '''
            let slo_target = 0.999;
            let burn_multiplier = 1.0;
            let threshold = (1.0 - slo_target) * burn_multiplier;
            let request_base = requests
              | where timestamp > ago(2d)
              | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                       path = tolower(coalesce(tostring(parse_url(url).Path), "<application>")),
                       weight = tolong(coalesce(itemCount, 1)),
                       status_code = toint(resultCode)
              | where not(path matches regex @"^/(?:api/)?(?:healthz?|readyz?|livez?|metrics)(?:/|$)");
            let short_window = request_base
              | where timestamp > ago(6h)
              | summarize short_total = sum(weight), short_errors = sumif(weight, status_code between (500 .. 599)) by role;
            let long_window = request_base
              | summarize long_total = sum(weight), long_errors = sumif(weight, status_code between (500 .. 599)) by role;
            short_window
            | join kind=inner long_window on role
            | extend short_rate = iff(short_total > 0, toreal(short_errors) / toreal(short_total), 0.0)
            | extend long_rate = iff(long_total > 0, toreal(long_errors) / toreal(long_total), 0.0)
            | where short_rate > threshold and long_rate > threshold and long_total > 100
            | project role, short_rate, long_rate, short_total, long_total, short_errors, long_errors
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#http-5xx-burn-rate-kql-scheduledqueryrules'
        severity: 'SEV-3'
      }
    }
    autoMitigate: false
  }
}

// =============================================================================
// Application Insights — Integration Event Alerts (Circuit Breaker + Probes)
// =============================================================================
// `trackEvent()` uses one exclusive transport: the Application Insights SDK
// writes legacy `customEvents`, while the OTel fallback writes `traces` with
// `customDimensions["event.name"]`. App-scoped queries cannot resolve the
// workspace-only `AppTraces` alias, so normalize these two app-scope tables.
// event.id is generated by both transports and makes retry/dedup semantics
// explicit; old rows without it get a row-local fallback key.
// =============================================================================

resource circuitBreakerOpenedAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-circuit-breaker-opened'
  location: location
  properties: {
    displayName: 'Integration - Circuit Breaker Opened'
    description: 'A provider circuit breaker transitioned to OPEN — short-circuiting calls. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
    severity: 0
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            let integration_events = union isfuzzy=true
              (customEvents
                | project timestamp, operation_Id, event_name = name, customDimensions, source = "legacy"),
              (traces
                | extend event_name = tostring(customDimensions["event.name"])
                | where isnotempty(event_name)
                | project timestamp, operation_Id, event_name, customDimensions, source = "otel")
              | extend event_id = tostring(customDimensions["event.id"])
              | extend event_key = iff(isempty(event_id), strcat(source, "|", operation_Id, "|", tostring(timestamp)), event_id)
              | summarize arg_max(timestamp, *) by event_key;
            integration_events
            | where timestamp > ago(5m)
            | where event_name == "CircuitBreakerStateChange"
            | where tostring(customDimensions["newState"]) == "open"
            | summarize count() by provider = tostring(customDimensions["provider"])
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
        severity: 'SEV-1'
      }
    }
    autoMitigate: false
  }
}

resource syntheticProbeFailingAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-synthetic-probe-failing'
  location: location
  properties: {
    displayName: 'Integration - Synthetic Probe Failing (>=3 failures in 15m)'
    description: 'A provider synthetic probe failed 3 or more times in the last 15 minutes — open ticket. Routes through ${alertsWebhookUrl}. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            let integration_events = union isfuzzy=true
              (customEvents
                | project timestamp, operation_Id, event_name = name, customDimensions, source = "legacy"),
              (traces
                | extend event_name = tostring(customDimensions["event.name"])
                | where isnotempty(event_name)
                | project timestamp, operation_Id, event_name, customDimensions, source = "otel")
              | extend event_id = tostring(customDimensions["event.id"])
              | extend event_key = iff(isempty(event_id), strcat(source, "|", operation_Id, "|", tostring(timestamp)), event_id)
              | summarize arg_max(timestamp, *) by event_key;
            integration_events
            | where timestamp > ago(15m)
            | where event_name == "SyntheticProbeResult"
            | where tostring(customDimensions["outcome"]) == "failure"
              or tostring(customDimensions["outcome"]) == "timeout"
            | summarize failures = count() by provider = tostring(customDimensions["provider"])
            | where failures >= 3
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: false
  }
}

// =============================================================================
// Application Insights — Dependency Failure Alert
// =============================================================================
// App Insights auto-instruments outbound HTTP into the `dependencies` table.
// Fires when more than 5 dependency failures occur in the last 15 minutes for
// any tracked target host (api.openai.com, api.anthropic.com, api.stripe.com,
// api.resend.com, s3.amazonaws.com). One rule, grouped by target, severity 1.
// =============================================================================

resource dependencyFailureAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-dependency-failures'
  location: location
  properties: {
    displayName: 'Integration - Outbound Dependency Failures (>5 in 15m)'
    description: 'Outbound dependency failures exceeded 5 in the last 15 minutes for one or more tracked providers (OpenAI, Anthropic, Stripe, Resend, S3). Routes through ${alertsWebhookUrl}. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            dependencies
            | where timestamp > ago(15m)
            | where success == false
            | where target has_any (
                "api.openai.com",
                "api.anthropic.com",
                "api.stripe.com",
                "api.resend.com",
                "s3.amazonaws.com",
                "amazonaws.com"
              )
            | summarize failures = count() by target
            | where failures > 5
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: false
  }
}

// =============================================================================
// Application Insights — Collector and Temporal Capacity Alerts
// =============================================================================
// The collector self-scrape exports a deliberately small set of operational
// series. It does not pass through a global metric filter, so application and
// Temporal native metrics arriving through OTLP remain intact.
// =============================================================================

resource collectorHeartbeatMissingAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-otel-collector-heartbeat-missing'
  location: location
  properties: {
    displayName: 'Telemetry - OTel Collector Heartbeat Missing'
    description: 'One or more always-on monitored Container Apps has not exported its collector uptime metric for 15 minutes. This covers a never-working telemetry pipeline without relying on prior signal history.'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: format('''
            let expected = print roles = dynamic({0})
              | mv-expand role = roles to typeof(string)
              | project role = tolower(role);
            let observed = customMetrics
              | where timestamp > ago(15m) and name startswith "otelcol_process_uptime"
              | project role = tolower(coalesce(cloud_RoleName, "unknown"))
              | distinct role;
            expected
            | join kind=leftanti observed on role
          ''', string(expectedTelemetryRoles))
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 2
            minFailingPeriodsToAlert: 2
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#telemetry-pipeline-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: true
  }
}

resource collectorBackpressureAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-otel-collector-backpressure'
  location: location
  properties: {
    displayName: 'Telemetry - OTel Collector Export Queue >=80%'
    description: 'An OTel collector export queue remained at least 80% full across the evaluation window — telemetry loss is imminent if the destination does not recover.'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            let sizes = customMetrics
              | where timestamp > ago(15m) and name == "otelcol_exporter_queue_size"
              | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                       exporter = tostring(customDimensions["exporter"]),
                       instance = tostring(customDimensions["service.instance.id"])
              | summarize queue_size = max(value) by bin(timestamp, 1m), role, exporter, instance;
            let capacities = customMetrics
              | where timestamp > ago(15m) and name == "otelcol_exporter_queue_capacity"
              | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                       exporter = tostring(customDimensions["exporter"]),
                       instance = tostring(customDimensions["service.instance.id"])
              | summarize queue_capacity = max(value) by bin(timestamp, 1m), role, exporter, instance;
            sizes
            | join kind=inner capacities on timestamp, role, exporter, instance
            | where queue_capacity > 0
            | extend fill_ratio = toreal(queue_size) / toreal(queue_capacity)
            | summarize samples = count(), p95_fill_ratio = percentile(fill_ratio, 95), max_fill_ratio = max(fill_ratio)
              by role, exporter, instance
            | where samples >= 3 and p95_fill_ratio >= 0.8
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#telemetry-pipeline-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: true
  }
}

resource temporalQueueDelayAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-temporal-queue-delay'
  location: location
  properties: {
    displayName: 'Temporal - Sustained Queue Delay (>60s average)'
    description: 'Workflow or activity tasks waited more than 60 seconds on average before a worker accepted them during the last 15 minutes. Grouped by task queue and signal type.'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: '''
            // These histograms are cumulative. Subtract the preceding 15m
            // baseline per process/queue before calculating a weighted mean;
            // summing raw values would repeatedly count the process lifetime.
            customMetrics
            | where timestamp > ago(30m)
            | where name in ("temporal_workflow_task_schedule_to_start_latency", "temporal_activity_schedule_to_start_latency")
            | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                     instance = tostring(customDimensions["service.instance.id"]),
                     task_queue = tostring(customDimensions["task_queue"])
            | summarize baseline_sum = maxif(valueSum, timestamp between (ago(30m) .. ago(15m))),
                        baseline_count = maxif(valueCount, timestamp between (ago(30m) .. ago(15m))),
                        recent_sum = maxif(valueSum, timestamp > ago(15m)),
                        recent_count = maxif(valueCount, timestamp > ago(15m)),
                        recent_points = countif(timestamp > ago(15m))
              by role, instance, task_queue, signal = name
            | where recent_points > 0
            | extend delay_sum = iff(isnull(baseline_sum) or recent_sum < baseline_sum, recent_sum, recent_sum - baseline_sum),
                     tasks = iff(isnull(baseline_count) or recent_count < baseline_count, recent_count, recent_count - baseline_count)
            | summarize delay_sum = sum(delay_sum), tasks = sum(tasks) by role, task_queue, signal
            | where tasks >= 5
            | extend average_delay_ms = toreal(delay_sum) / toreal(tasks)
            | where average_delay_ms > 60000
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#temporal-capacity-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: true
  }
}

resource temporalSlotsExhaustedAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') {
  name: '${resourcePrefix}-temporal-task-slots-exhausted'
  location: location
  properties: {
    displayName: 'Temporal - Task Slots Exhausted (15m)'
    description: 'All worker replicas reported zero available slots for the same task queue and worker type throughout the 15-minute window.'
    severity: 1
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            customMetrics
            | where timestamp > ago(15m) and name == "temporal_worker_task_slots_available"
            | extend role = tolower(coalesce(cloud_RoleName, "unknown")),
                     task_queue = tostring(customDimensions["task_queue"]),
                     worker_type = tostring(customDimensions["worker_type"])
            // Sum replicas for each minute. Alert only if aggregate capacity
            // stayed at zero; one saturated replica beside a free replica is
            // not a capacity incident.
            | summarize available = sum(value) by bin(timestamp, 1m), role, task_queue, worker_type
            | summarize samples = count(), max_available = max(available) by role, task_queue, worker_type
            | where samples >= 5 and max_available <= 0
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#temporal-capacity-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: true
  }
}

// Container Apps captures the sidecar's stderr independently of its telemetry
// pipeline. Cover observable pipeline rejection/drop conditions here. The
// pinned Azure exporter reports asynchronous transport failures only at debug,
// so the heartbeat-missing rule is the production transport-outage signal.
resource collectorPipelineFailureAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (logAnalyticsWorkspaceId != '') {
  name: '${resourcePrefix}-otel-collector-pipeline-failures'
  location: location
  properties: {
    displayName: 'Telemetry - OTel Collector Pipeline Failures'
    description: 'An OTel collector sidecar logged at least five pipeline processing, rejection, queue-full, or drop failures in 15 minutes. Azure transport outages are detected by the missing-heartbeat rule.'
    severity: 1
    enabled: true
    scopes: [logAnalyticsWorkspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where TimeGenerated > ago(15m)
            | where ContainerName_s == "otel-collector"
            | where Log_s has "Exporting failed"
              or Log_s has "Dropping data"
              or Log_s has "Rejecting data"
              or Log_s has "sending queue is full"
              or Log_s has "sending_queue is full"
              or Log_s has "Failed to process"
            | summarize failures = count() by ContainerAppName_s
            | where failures >= 5
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#telemetry-pipeline-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: true
  }
}

// =============================================================================
// Log Analytics — Repo Integration Credential Health Alert Rules
// =============================================================================
// The scheduled repo-integration-health-check workflow runs every ~30 min and
// logs its outcome to the worker's stdout (→ ContainerAppConsoleLogs_CL in the
// Log Analytics workspace). Unlike the LLM / burn-rate rules above, these
// signals are NOT in App Insights `requests`/`dependencies` — a background job's
// raw fetch() is never auto-instrumented there — so these two rules are scoped
// at the Log Analytics workspace and parse the console log directly. This is
// the signal class that a "process is healthy / requests are fine" alert can
// never see: a cron job that runs perfectly but fails at its PURPOSE.
//
// Two deliberately-distinct rules, because "N integrations unhealthy" conflates
// two very different causes that need different responses:
//   1. A user's GitHub refresh token is revoked/expired — normal, low-urgency,
//      fixed by the user reconnecting (the Atlas "Reconnect" affordance). A
//      steady baseline of these is expected and must NOT page anyone.
//   2. The WORKER's configured OAuth APP credentials are wrong — a config
//      emergency that breaks refresh for EVERY integration at once, fixed only
//      by an operator. GitHub returns a distinct "client_id and/or client_secret
//      incorrect" message for this, never for case 1.
// =============================================================================

// Rule 1 (the high-signal one): the worker's GitHub App client_id/secret were
// rejected by GitHub. This string only appears on a config error — never on a
// user's dead token — so a single occurrence is actionable with zero false
// positives. This is exactly the failure that ran silently for weeks because no
// existing alert watches a background job's own outcome.
resource repoOauthCredentialsRejectedAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (logAnalyticsWorkspaceId != '') {
  name: '${resourcePrefix}-repo-oauth-credentials-rejected'
  location: location
  properties: {
    displayName: 'Integration - GitHub OAuth App Credentials Rejected (config error)'
    description: 'The temporal-worker\'s configured GitHub OAuth app client_id/secret were rejected by GitHub during a repo-integration token refresh. This is a configuration error (wrong/stale FABRIC_GITHUB_CLIENT_ID/SECRET) — NOT a user\'s expired token — and breaks credential refresh for every GitHub integration in this environment. Fix the GitHub OAuth secrets in Key Vault / the deploy environment and restart the worker. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
    severity: 2
    enabled: true
    scopes: [logAnalyticsWorkspaceId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT45M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where TimeGenerated > ago(45m)
            | where ContainerAppName_s endswith 'temporal-worker'
            | where Log_s has 'client_id and/or client_secret'
            | summarize Rejections = count()
            | where Rejections > 0
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
        severity: 'SEV-2'
      }
    }
    autoMitigate: false
  }
}

// Rule 2 (broad safety net): more than half of all monitored repo integrations
// are unhealthy in the latest cycle. Ratio-based on purpose — a steady baseline
// of individually-dead user tokens (case 1) stays well under 50% and does NOT
// fire, but a systemic failure (mass revocation, total GitHub egress outage, or
// the credential error above before Rule 1's string is matched) pushes the
// ratio over the line. SEV-3: ticket / weekly digest, never a page.
resource repoHealthDegradedAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (logAnalyticsWorkspaceId != '') {
  name: '${resourcePrefix}-repo-health-degraded'
  location: location
  properties: {
    displayName: 'Integration - Repo Health Degraded (>50% unhealthy)'
    description: 'More than half of the monitored repository integrations were unhealthy in the most recent scheduled health-check cycle — a systemic problem (mass token revocation, GitHub egress outage, or wrong worker OAuth app credentials) rather than the normal trickle of individually-expired user tokens. See the alert catalogue: https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
    severity: 3
    enabled: true
    scopes: [logAnalyticsWorkspaceId]
    evaluationFrequency: 'PT30M'
    windowSize: 'PT60M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where TimeGenerated > ago(60m)
            | where ContainerAppName_s endswith 'temporal-worker'
            | where Log_s has 'RepoHealthCheck' and Log_s has 'Cycle complete'
            | parse Log_s with * 'Cycle complete: ' healthy:int ' healthy, ' unhealthy:int ' unhealthy' *
            | where isnotnull(unhealthy) and isnotnull(healthy)
            | top 1 by TimeGenerated desc
            | extend total = healthy + unhealthy
            | where total > 0 and (toreal(unhealthy) / toreal(total)) > 0.5
          '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook_url: 'https://github.com/Fabric-Pro/fabric-oss/blob/master/docs/monitoring/alerts.md#integration-health-kql-scheduledqueryrules'
        severity: 'SEV-3'
      }
    }
    autoMitigate: false
  }
}

// =============================================================================
// Outputs
// =============================================================================

output actionGroupId string = actionGroup.id
output actionGroupName string = actionGroup.name
// 2 per Container App (replica + restart) + 6 LLM rules + 3 burn-rate +
// 2 integration-event + 1 dependency + 2 collector + 2 Temporal = +16
// when appInsightsId is set; + 1 Key Vault + 1 collector-pipeline + 2
// repo-integration credential-health rules when logAnalyticsWorkspaceId is set.
output alertRuleCount int = length(monitoredContainerApps) * 2 + (appInsightsId != '' ? 16 : 0) + (logAnalyticsWorkspaceId != '' ? 4 : 0)

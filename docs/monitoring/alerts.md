# Monitoring Alerts

Catalogue of every deployed alert rule, severity ladder, multi-window
burn-rate math, and how to add a new alert.

- **Audience**: On-call engineers and platform developers
- **Owner**: Platform / SRE

## Alert routing

Every rule in `deployment/azure/modules/monitoring.bicep` references the
single `${resourcePrefix}-alerts-ag` Action Group. The Action Group's
one `webhookReceiver` posts the Azure Common Alert Schema (CAS) payload
to `ALERTS_WEBHOOK_URL`, which is the Power Automate flow that fans out
to Teams, Slack, and email.

```
[Azure Monitor metric alert or scheduledQueryRules]
  -> [Action Group: ${prefix}-alerts-ag] webhookReceiver "AlertsWorkflow"
  -> [POST ${alertsWebhookUrl}] — Azure CAS payload
  -> [Power Automate flow] fans out to Teams + Slack + email
```

No alert bypasses the funnel. No alert has a parallel webhook. See
[`architecture.md#single-funnel-principle`](./architecture.md#single-funnel-principle)
for the rationale.

## Severity ladder

The CAS `severity` field is set per rule and drives routing in Power
Automate. The numeric ladder follows Azure Monitor convention (lower is
more severe).

| Severity | Azure level | Meaning | Notification | Response time |
|---|---|---|---|---|
| **SEV-1** | 0 — Critical | Customer-impacting outage. The platform is down or core functionality is broken. | Teams `@channel` + Slack + email + on-call page (if PagerDuty wired in Power Automate). | Page on-call — under 15 minutes acknowledged. |
| **SEV-2** | 1 — Error | Degraded but functional. Provider partial outage, slow LLM provider, dependency failure. | Teams card + Slack message + admin email. | Business hours — same day acknowledged. |
| **SEV-3** | 3 — Informational | Chronic issue, ticket-only. Sustained low-grade error rate over 6 h + 2 d windows. | Surfaced in the weekly digest (Monday 09:00 UTC) only. | Backlog — ticket, no live notification. |

`severity: 2` (Warning) is used by Container App restart alerts as a
matter of Azure-Monitor convention; in product terminology those are
SEV-2.

## Multi-window multi-burn-rate pattern

The HTTP 5xx burn-rate rules follow the Google SRE Workbook's
multi-window multi-burn-rate convention (see chapter "Alerting on SLOs").
Each rule requires BOTH a short window AND a long window to breach the
same threshold simultaneously. The short window fires the alert fast; the
long window confirms the breach is sustained.

For a 99.9 % SLO (0.1 % error budget):

```
threshold = (1 - SLO_target) * burn_multiplier
          = 0.001 * burn_multiplier
```

| Severity | Burn × | Short window | Long window | Implied budget exhaustion |
|---|---|---|---|---|
| SEV-1 | **14.4×** | 5 min | 1 h | Monthly budget burns in ~2 h. |
| SEV-2 | **6×** | 30 min | 6 h | Monthly budget burns in ~5 d. |
| SEV-3 | **1×** | 6 h | 2 d | Sustained at the SLO baseline — no error budget at all over the long window. |

The 14.4× number comes from the SRE Workbook table: alerting at 14.4×
the sustainable rate over 1 hour catches 2 % of the monthly budget being
consumed in one window, which is the canonical "page now" threshold.

A long-window minimum-count floor (`long_total > 10` / `30` / `100`)
prevents low-traffic features from paging on a single error. Without
this floor, one 500 in a feature that sees 10 requests a day would
saturate the rate and page on-call.

![Read-only "Alert thresholds" section of the admin monitoring page, listing the SEV-1/2/3 burn-rate windows alongside the integration-signal trigger conditions and recovery hysteresis.](./assets/admin-monitoring-dashboard.png)

The admin dashboard renders the same thresholds described here in a
human-readable form. Editing them is a code change in
`packages/observability` plus a Bicep redeploy — there is no in-app
edit UI.

## Alert rule catalogue

Every rule below is defined in
[`deployment/azure/modules/monitoring.bicep`](../../deployment/azure/modules/monitoring.bicep).
All rules emit through the shared Action Group; no rule has a separate
webhook.

Each rule's `customProperties.runbook_url` carries a link back to this
catalogue, so the Teams card lands the responder on the rule that fired.
What happens next is in [`incidents.md`](./incidents.md); mitigation steps
are deployment-specific and belong in the operator's own runbook.

### HTTP 5xx burn rate (KQL scheduledQueryRules)

| Alert name | Severity | Eval freq | Window | KQL summary | Threshold |
|---|---|---|---|---|---|
| `${prefix}-http-5xx-burn-rate-sev1` | SEV-1 | 5 min | 1 h | `requests` table, short=5 m + long=1 h | `short_rate > 0.0144 AND long_rate > 0.0144 AND long_total > 10` |
| `${prefix}-http-5xx-burn-rate-sev2` | SEV-2 | 15 min | 6 h | `requests` table, short=30 m + long=6 h | `short_rate > 0.006 AND long_rate > 0.006 AND long_total > 30` |
| `${prefix}-http-5xx-burn-rate-sev3` | SEV-3 | 1 h | 2 d (capped at Azure max P2D) | `requests` table, short=6 h + long=2 d | `short_rate > 0.001 AND long_rate > 0.001 AND long_total > 100` |

### LLM-specific (KQL scheduledQueryRules)

The LLM rules query the `dependencies` and `requests` tables, filtering
on `name startswith "llm."` (the span name pattern emitted by the
OpenTelemetry instrumentation). All require `appInsightsId` to be set
to deploy.

| Alert name | Severity | Eval freq | Window | Trigger |
|---|---|---|---|---|
| `${prefix}-llm-high-error-rate` | SEV-1 | 5 min | 5 min | LLM error rate > 10 % over the last 5 min. |
| `${prefix}-llm-provider-error-rate` | SEV-2 | 5 min | 5 min | A single provider's LLM error rate > 25 %. Grouped by `customDimensions["gen_ai.system"]`. |
| `${prefix}-llm-high-latency` | SEV-2 | 5 min | 5 min | Any provider's P95 LLM latency > 30 000 ms. |
| `${prefix}-llm-token-usage-spike` | SEV-2 | 5 min | 1 h | 5-min token usage > 5× hourly average. Bin by 5 m. |
| `${prefix}-llm-high-output-token-rate` | SEV-2 | 5 min | 5 min | Output tokens per second > 5 000 for any model/provider pair. |
| `${prefix}-llm-no-requests` | SEV-2 | 5 min | 6 h | Zero LLM requests in the last 15 min AND prior activity in the 6 h before. Detects instrumentation breakage. |

### Integration health (KQL scheduledQueryRules)

| Alert name | Severity | Eval freq | Window | Trigger |
|---|---|---|---|---|
| `${prefix}-circuit-breaker-opened` | SEV-1 | 1 min | 5 min | Any `customEvents` row with `name == "CircuitBreakerStateChange"` and `newState == "open"`. Grouped by `provider`. |
| `${prefix}-synthetic-probe-failing` | SEV-2 | 5 min | 15 min | 3+ failures for a provider in `customEvents` where `name == "SyntheticProbeResult"`. |
| `${prefix}-dependency-failures` | SEV-2 | 5 min | 15 min | More than 5 dependency failures in 15 min for `api.openai.com`, `api.anthropic.com`, `api.stripe.com`, `api.resend.com`, or `*.amazonaws.com`. Grouped by `target`. |
| `${prefix}-repo-oauth-credentials-rejected` | SEV-2 | 15 min | 45 min | The worker's GitHub OAuth app credentials were rejected during a repo-integration token refresh — a configuration error, not an expired user token. |
| `${prefix}-repo-health-degraded` | SEV-3 | 30 min | 1 h | More than half the monitored repository integrations were unhealthy in the most recent health-check cycle. |

### Container App availability (metric alerts)

Two rules per app, emitted in a `[for app in monitoredContainerApps: ...]` loop. The
`monitoredContainerApps` array is auto-derived from `tsAgentConfigs`
plus the two standalone apps, so adding a new TS/LangGraph agent
automatically enrols it.

| Alert name template | Severity | Eval freq | Window | Trigger |
|---|---|---|---|---|
| `${prefix}-${app.name}-replica-alert` | SEV-1 if `app.critical` else SEV-2 | 5 min | 5 min | Replica count ≤ 0. Maximum aggregation. |
| `${prefix}-${app.name}-restart-alert` | SEV-2 | 5 min | 5 min | RestartCount > 5 over 5 min. Total aggregation. |

Multi-resource alert rules for `Microsoft.App/containerApps` are not yet
supported by Azure Monitor (table verified May 2026), so the per-app
loop is the workaround. The Bicep file carries a migration sketch that
collapses 2N rules into 2 once Microsoft adds containerApps to the
supported list.

## Tunable thresholds

The Bicep parameters that admins typically want to tune live at the top
of `monitoring.bicep`:

| Parameter | Default | Effect |
|---|---|---|
| `alertEmail` | empty | If non-empty, appends an `emailReceiver` to the Action Group. |
| `alertsWebhookUrl` | empty (secure) | The Power Automate webhook. If empty, no webhook receiver is created (alerts still fire to Azure Monitor but do not fan out). |
| `monitoredContainerApps` | `[]` | Array of `{ name, resourceId, critical }`. Wired from `main.bicep` from `tsAgentConfigs`. |
| `appInsightsId` | empty | When set, the 12 KQL-based rules deploy. When empty, only the per-app metric alerts deploy. |

Per-rule thresholds (burn multiplier, error rate %, latency ms, token
rate) are inlined in the KQL `let` bindings at the top of each rule.
Changing them is a Bicep edit and a deploy.

The dashboard at `/app/admin/monitoring` renders the thresholds
read-only via `ThresholdConfigDisplay.tsx` so admins can audit the
current values without grepping Bicep.

## Adding a new alert

### KQL scheduledQueryRule (App Insights signal)

1. Add a `resource <name>Alert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (appInsightsId != '') { ... }` block to `deployment/azure/modules/monitoring.bicep`.
2. Set the KQL `query` against the right table:
   - `requests` for HTTP traffic.
   - `dependencies` for outbound calls and LLM spans (filter on
     `name startswith "llm."`).
   - `customEvents` for breaker / probe / business-domain signals.
3. Set `severity: 0|1|3` and `scopes: [appInsightsId]`.
4. Reference the shared `actionGroups: [actionGroup.id]` — never create
   a parallel Action Group.
5. Add a `customProperties.runbook_url` pointing to this document's
   section for the rule's family, so the CAS payload carries it. The
   headings are link targets — renaming one breaks every alert that
   points at it.
6. Bump the `alertRuleCount` output to keep the deploy summary honest.

### Container-App metric alert

For most workloads the existing replica + restart loop is enough. If
you need a new metric (e.g., memory pressure, queue depth), append a
new `resource fooAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' =
[for app in monitoredContainerApps: ...]` block to
`monitoring.bicep`. The loop auto-discovers every monitored Container
App; no per-app edit required.

### Provider-side signal (statuspage / probe / breaker)

You do not add a new alert rule. You add a new `registerIntegrationProvider`
entry in `packages/observability/lib/integration-providers.ts` and the
existing breaker / probe / statuspage rules pick it up. See
[`status-pages.md#adding-a-new-provider`](./status-pages.md#adding-a-new-provider).

## Testing a new alert

- **Local**: run `pnpm --filter @repo/temporal test` for workflow rules
  and `pnpm --filter web test` for KQL contract tests against fixtures.
- **Bicep**: `az deployment group what-if` against the staging RG
  shows the alert-rule diff. The `alertRuleCount` output should match
  the expected count.
- **End-to-end**: post a synthetic CAS payload to the dev Action Group
  via `az monitor action-group test-notifications` to verify the Power
  Automate flow renders correctly without waiting for the real signal.

## See also

- [`architecture.md`](./architecture.md) — system context and data flow.
- [`incidents.md`](./incidents.md) — what happens after the alert fires.
- [`status-pages.md`](./status-pages.md) — provider-side detection and
  the registry.
- [`../adr/005-monitoring-architecture.md`](../adr/005-monitoring-architecture.md) — backend choice and funnel rationale.

## Alertmanager webhook ingestion (v3)

In addition to the Azure Monitor → Action Group funnel above, Fabric
exposes a Prometheus Alertmanager-style ingestion endpoint at
`POST /api/incidents/alertmanager`. This is the path third-party
monitoring systems (or our own internal subsystem probes) use to fire
incidents directly into the Postgres incident tables — bypassing the
Power Automate fan-out, since the recipient is the application itself,
not a chat channel.

The endpoint accepts the standard Alertmanager webhook payload with an
added `kind` discriminator:

| `kind` value | Target table | Purpose |
|---|---|---|
| `error_rate` | `ErrorRateIncident` | HTTP 5xx burn-rate alerts (mirrors the Azure path; useful when running against a non-Azure environment) |
| `integration` | `IntegrationIncident` | External provider outages (mirrors statuspage polling + synthetic probes) |
| `component` *(v3)* | `ComponentIncident` | Internal Fabric subsystem outages — Temporal worker stalled, Prisma drift detected, RAG indexer queue backed up, agent rail down, etc. |

Each `kind` writes to its own table but shares the `IncidentEvent`
ledger so the admin dashboard timeline renders all three streams
together. De-duplication is per-table via `alertmanagerFingerprint`
(unique constraint) — repeated fires of the same alert update the
existing row instead of creating duplicates.

See [`incidents.md`](./incidents.md) for the data-model details and
the auto-resolve hysteresis rules. Tests live at
`apps/web/app/api/incidents/alertmanager/__tests__/route.test.ts`.

# ADR-005: Application Insights as the Monitoring Backend with Single Webhook Funnel

- **Status**: Accepted
- **Date**: 2026-05-16
- **Deciders**: Engineering team

## Context

The parent app-downtime alerts spec (`fabric/specs/2026-03-26-app-downtime-alerts`)
shipped Container App replica-count and crash-loop alerts. They satisfy
the "is the platform up?" question but stop there. The product needs:

- HTTP-error spike detection against a 99.9 % SLO using the SRE
  Workbook multi-window multi-burn-rate convention.
- Provider outage detection for the 33 third-party integrations
  registered in `packages/observability/lib/integration-providers.ts`,
  including OpenAI, Anthropic, Stripe, Resend, and 28 user-configured
  data connections.
- An operator surface (Teams, Slack, email) and an in-product surface
  (incident chip, notification inbox, admin dashboard) that share a
  single source of truth.

A prototype using self-hosted Prometheus + Alertmanager on Container
Apps was built and validated. It worked but ran at ~$11 / month and
duplicated infrastructure that Azure already operates for free at our
scale (Application Insights is already deployed for the platform).

## Decision

Use **Azure Application Insights** as the metrics and alerting backend.
KQL `scheduledQueryRules` over the App Insights `requests`,
`dependencies`, and `customEvents` tables replace the burn-rate /
breaker / probe / dependency Prometheus rules from the prototype.

All alert rules (12 KQL-based plus 2 metric alerts per Container App)
emit through **a single Action Group** with **one webhookReceiver**
posting to the parent spec's existing `ALERTS_WEBHOOK_URL`. Power
Automate fans the CAS payload out to Teams, Slack, and email. There is
no parallel notification path, no in-process Teams adapter, no separate
Action Group for breakers or probes.

App Insights Smart Detection (auto-enabled, no rule needed) replaces
the "general anomaly" use case the Prometheus prototype handled via
hand-tuned rules. Custom KQL rules exist only for the SLO-bound cases
that need explicit thresholds (HTTP 5xx burn-rate, LLM-specific,
breaker state changes, synthetic probe failures, dependency failures).

## Alternatives Considered

1. **Self-hosted Prometheus + Alertmanager on Container Apps**
   (prototyped). Cost: ~$11 / month. Pros: portable; same stack the
   team has run elsewhere; rich PromQL. Cons: an extra Container App to
   monitor; deduplicates infrastructure Azure already provides; an
   extra Alertmanager-native webhook to maintain in Power Automate.
   Decision: reject — cost and duplication outweigh portability.

2. **Azure Monitor managed Prometheus (Workspaces for Prometheus)**.
   Pros: managed PromQL without self-host. Cons: pay-per-sample
   pricing model is harder to predict; would require recorder /
   alerting-rules workspace setup; PromQL rules vs KQL rules is a
   parallel rule language we would have to maintain. Decision: reject
   for v1 — App Insights covers the same surface area with no new
   infrastructure.

3. **Datadog / New Relic SaaS**. Pros: best-in-class UX. Cons: a third
   parallel infrastructure (next to the existing Azure stack and the
   existing OTel exporters); per-host pricing; another vendor on the
   security review surface. Decision: reject — too much new surface
   for an MVP.

## Consequences

- **$0 added Azure cost.** App Insights is already deployed; the
  Bicep alert rules cost ~$2.30 / month combined (Azure Monitor pricing,
  exempt from the free tier on `scheduledQueryRules`).
- **All alerts inherit the existing webhook + Action Group plumbing.**
  The single-funnel principle is preserved. New alerts route to the
  same destinations by construction — `actions.actionGroups:
  [actionGroup.id]` is the only line that changes per rule.
- **Smart Detection replaces PromQL multi-burn-rate for the general
  case.** Smart Detection ships with App Insights, requires no rule
  authoring, and covers response-time / dependency / exception anomalies.
- **Custom KQL `scheduledQueryRules` cover the SLO-bound cases.** Three
  burn-rate rules for HTTP 5xx (SEV-1/2/3), six LLM-specific rules
  (error rate, provider error rate, latency, token spike, output rate,
  silence), one circuit-breaker rule, one synthetic-probe rule, and one
  dependency-failure rule. See [`docs/monitoring/alerts.md`](../monitoring/alerts.md)
  for the catalogue.
- **Bound to the Azure ecosystem.** Migrating off Azure would require
  re-authoring rules in another language. We are already bound to
  Azure for Container Apps, so this is not a new constraint.
- **No in-process adapter to maintain.** The deleted prototype had an
  Alertmanager webhook handler in the API service. With everything
  routed through Power Automate, the API service only receives
  acknowledge / resolve signals from the admin UI — no inbound alert
  parsing.
- **Action Group is shared.** A regression in any alert rule routes to
  the same channels. Operators need one runbook ("read the CAS
  payload"). The verification matrix in
  [`docs/operations/funnel-verification.md`](../operations/funnel-verification.md)
  proves the funnel is intact after a Bicep change.
- **In-app surfaces are role-gated, not path-gated.** The IncidentChip
  (replaced the earlier full-width IncidentBanner — see
  `incidents.md#app-shell-incident-chip` for the rationale) and the
  inbox-link-to-dashboard flow defer visibility to the recipient's role
  (system admin or active-org owner) rather than the current pathname.
  Earlier iterations pinned the banner to admin / settings routes for
  every user, which hid it on the product surfaces where an admin
  actually works. The role gate is page-agnostic, and the inbox row
  degrades to a toast for non-admins so the admin-gated dashboard is
  never silently redirected from a notification click.
- **`NOT_CONFIGURED` is a first-class provider state.** When a
  synthetic probe cannot run because the required credential env var
  is absent, the provider lands in `NOT_CONFIGURED` rather than
  `UNKNOWN`. Distinguishing "we cannot probe" from "the probe says
  unknown" is operationally important — `NOT_CONFIGURED` is a
  deploy-time gap (fix in `.env`), `UNKNOWN` is a runtime gap (the
  provider's own feed is degraded). Neither opens an incident.

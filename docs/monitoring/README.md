# Monitoring

Index of monitoring documentation for the Fabric platform — application
error-rate detection, integration outage detection, and incident
management.

- **Audience**: Developers and on-call operators
- **Owner**: Platform / SRE

## Sub-documents

| Document | One-line description |
|---|---|
| [architecture.md](./architecture.md) | End-to-end design: signal sources, single-funnel alert routing, Provider Registry, auto-discovery, in-app chip placement and role-based visibility, data flow, feature flags, cost. |
| [alerts.md](./alerts.md) | Catalogue of every deployed alert rule (Bicep + Application Insights KQL), severity ladder, multi-window burn-rate math, tunable thresholds, how to add a new alert, **alertmanager webhook ingestion with `kind` discriminator *(v3)***. |
| [incidents.md](./incidents.md) | **Three incident types** (`ErrorRateIncident`, `IntegrationIncident`, `ComponentIncident` *(v3 — internal Fabric subsystem outages)*), shared `IncidentEvent` ledger, FIRING → ACKNOWLEDGED → RESOLVED lifecycle, auto-resolve hysteresis, **admin-only chip + notification visibility *(v3 change)***, admin UI workflow, permissions, extension points. |
| [customer-status.md](./customer-status.md) | **Customer-facing** `/app/system-health`: the six components and the signal behind each, precedence when signals disagree, why a stale signal is UNKNOWN and never green, the `StatusUpdate` announcement model and how to write one, external API-key access. Supersedes the v1 "no customer-facing status page" non-goal. |
| [status-pages.md](./status-pages.md) | Atlassian Statuspage default parser, six custom parsers, component filtering, three coverage buckets, full provider list, adding a new provider, rate-limit policy. |

## Decision record

| ADR | Title |
|---|---|
| [ADR-005](../adr/005-monitoring-architecture.md) | Application Insights as the monitoring backend with single webhook funnel. |

## Related runbooks

- [`docs/runbooks/error-rate-spike.md`](../runbooks/error-rate-spike.md) — response steps for SEV-1/2/3 HTTP 5xx burn-rate alerts.
- [`docs/runbooks/integration-outage.md`](../runbooks/integration-outage.md) — response steps for provider outages (statuspage, breaker, synthetic probe).
- [`docs/runbooks/downtime-alert-resolution.md`](../runbooks/downtime-alert-resolution.md) — response steps for Container App replica / restart alerts (parent app-downtime spec).

## How to read these docs

- Start with [`architecture.md`](./architecture.md) if you are new to
  the platform — it sets the system context for everything else.
- Jump to [`alerts.md`](./alerts.md) when an alert has just fired and
  you need to know what it means.
- Jump to [`incidents.md`](./incidents.md) when you are responding to
  a live incident or extending the incident model.
- Jump to [`status-pages.md`](./status-pages.md) when you are adding
  or maintaining a third-party integration in the registry.
- Read [ADR-005](../adr/005-monitoring-architecture.md) when you need
  to justify a backend choice or evaluate a replacement.

Each sub-document is authoritative and self-contained — references
runbooks and other docs by link rather than duplicating content.

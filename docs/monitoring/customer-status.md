# Customer-facing system health

The authenticated status surface at `/app/system-health` (and
`/app/{organizationSlug}/system-health`), and the `StatusUpdate` announcements
behind it.

- **Audience**: Developers, on-call operators, and whoever writes announcements
  during an incident
- **Owner**: Platform / SRE

This supersedes the "Customer-facing public status page" non-goal in
[architecture.md](./architecture.md#non-goals-v1). It is not a public page: every
surface requires a session or an API key.

## What a customer sees

Six platform components, each with a status, a plain-language description, and a
one-line reason. Then any active announcements, then 90 days of resolved ones.
Third-party provider problems appear **only** for providers that tenant has
connected.

What a customer never sees: SEV values, alert names, Alertmanager fingerprints,
hostnames, internal component keys, incident-row identifiers, or any other
tenant's data. `ComponentIncident.summary` is machine-written from alert payloads
and is deliberately never projected — an incident moves a component's status and
contributes a generic sentence, nothing more.

## Where each status comes from

Statuses resolve at **read time** from plain Postgres reads. This page runs no
prober of its own, deliberately: a prober that depends on the workflow engine goes
dark in the same outage it is meant to report, and a reachable-but-idle engine is
exactly the failure a liveness ping calls healthy.

That is narrower than "nothing is probed". `syntheticProbeWorkflow` DOES actively
probe providers — an HTTP or SDK canary per provider every 5 minutes, opening a
SEV-2 `IntegrationIncident` after consecutive failures — and those incidents reach
this page as `providerIssues`. What resolves at read time is the per-component
status; provider reachability is measured, not inferred.

| Component | Signal |
|---|---|
| Application & API | the tenant's own server-fault rate in `audit_log` over 15 min (`error.internal`/`unavailable`/`timeout` only) |
| Background processing | freshness of `max(IntegrationProviderRegistry.lastPolledAt)`, written every 2 min by the status-page poller |
| AI generation | rollup of registry health for the platform AI providers |
| Integration sync | the tenant's own `DataConnection` statuses + open provider incidents for providers they connected |
| File storage | registry health for the object-store provider |
| Email delivery | registry health for the mail provider |

Registry: `packages/observability/lib/platform-component-registrations.ts`.
Adding a component is a config-only change — but only add one that has a **real**
signal. A component whose health cannot be measured renders a permanent green,
which is indistinguishable from "never checked".

### Precedence when signals disagree

**Announcement > detected incident > inferred signal.** A human who published an
announcement outranks a probe reading green. Fixed in
`resolveComponent`; do not re-derive it per caller.

### Two rules that exist to prevent false reassurance

- **A stale signal resolves to `UNKNOWN`, never to `OPERATIONAL`.** Past its
  freshness threshold the signal is dead, and a dead signal must not render as
  healthy.
- **A failed signal read degrades only its own component.** The reads are settled
  individually, so a datastore problem yields a partial answer rather than a
  blank page. `Promise.all` here would let one failure black out the whole
  surface — in the outage the page exists for.

### `NOT_CONFIGURED` does not mean "switched off"

It means the synthetic probe could not run because its credential is absent in
this environment. The capability is usually working. The badge therefore reads
**Not monitored**, and the copy says we are not monitoring it here and it may be
fine. Do not reword this to imply the feature is disabled — that shipped once and
was wrong on staging for two of six components.

## Announcements

`StatusUpdate` + `StatusUpdateRevision` are deliberately separate from the
incident tables. Those are *detections*: machine-written, fingerprinted, carrying
internal topology. An announcement is what a customer **reads** — human-authored,
customer-safe, with a lifecycle a non-operator understands.

The link is loose and optional: a detection may get zero or one announcement, and
an announcement may exist with no detection at all (planned maintenance, or a
vendor issue learned out-of-band).

Both tables are **global**. Per-tenant relevance is derived at read time from the
tenant's own connections; nothing is stored per tenant, so publishing fans out to
nothing. True per-tenant announcements would need a schema change.

### Writing one

Admin monitoring dashboard → **Customer status announcements**, directly beneath
the open-incident list. Write for a customer: no root cause, no internal
component names, no hostnames.

Revisions are **append-only** — no edit or delete path exists. A correction is a
new revision. Rewriting what customers were already told defeats the purpose of
publishing a timeline.

`resolvedAt` tracks the *current* terminal state: appending another terminal
revision keeps it, and reopening clears it. The durable history is the revision
list, not that column.

## External access

| Endpoint | Scope |
|---|---|
| `GET /api/v1/system-health` | `system_health:read` |
| `GET /api/v1/status-updates` | `status_updates:read` |

Separate scopes because the overview carries the tenant's **own** signals while
announcement history carries none — so a monitor can be granted platform status
without anything about the workspace. Keys are minted from Settings → Audit Log →
Manage API keys.

The overview is served by the same builder the in-product procedure calls, so the
two cannot drift into exposing different fields.

**Self-hosted caveat:** this surface is behind the shared API-key middleware,
which rate-limits via Redis and **fails closed**. A deployment with no
`UPSTASH_REDIS_REST_URL` / `_TOKEN` returns 503 on every call, permanently. The
response body names the missing variables. See
[`docs/audit-log/api.md`](../audit-log/api.md#a-503-is-usually-a-misconfiguration-not-a-blip).

## Feature flags

None. The customer surface is not flag-gated; the authoring card inherits
`feature-admin-monitoring-dashboard` from the page it sits on.

## Known gaps

- **No i18n** — the dashboard and authoring card ship hardcoded English, matching
  the admin monitoring dashboard.
- **`/api/health` checks nothing, and that is now deliberate.** Listed here
  earlier as a gap; on inspection it is the correct design and changing it would
  have been harmful. That path is the Kubernetes **liveness** probe as well as the
  readiness probe, plus the ALB `healthcheck-path`, the container `HEALTHCHECK`,
  the CI smoke gate and the external uptime monitor. Had it failed on an
  unreachable Postgres, a transient blip would trip liveness three times in a
  minute and Kubernetes would kill every web pod while the ALB drained every
  target — a degraded-but-serving app converted into a hard outage by its own
  health check. The dependency checks live at **`/api/health/ready`** instead,
  which returns 200/503 with a per-check body and is wired to nothing. Pointing
  the *readiness* probe at it would be defensible (readiness removes a pod from
  the load balancer without restarting it); that is an infrastructure decision
  with a blast radius, not a passing code change.
- ~~**`ErrorRateIncident` has no production writer**~~ — **resolved, and the claim
  was wrong when written.** `upsertAlertmanagerIncident` already implemented the
  path (fingerprint dedupe, reopen-on-refire, incident events, audit bridge); it was
  simply never called from production. The alertmanager route now handles
  `kind: "errorRate"` through it. `integration` remains with the Temporal poller,
  which genuinely owns those rows. See [incidents.md](./incidents.md).
- **Customers are not notified** of a status change. `notifyIncident` is inert by
  an earlier deliberate decision — do not revive it; notifying about an
  announcement is a different problem. Only the weekly digest to Fabric admins
  fires, so reaching a customer still means the announcement plus whatever channel
  a human uses. The design for closing this, and the three decisions it needs, are
  in [announcement-notifications.md](./announcement-notifications.md).

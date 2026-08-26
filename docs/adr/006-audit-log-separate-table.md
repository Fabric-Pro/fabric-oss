# ADR-006: Audit Log as a Dedicated `AuditLog` Table

- **Status**: Accepted
- **Date**: 2026-05-18
- **Deciders**: Engineering team

## Context

The audit-log feature (see
[`../audit-log/`](../audit-log/) for the canonical documentation) must
satisfy four acceptance criteria:

1. Record every significant actor-driven action (auth, project,
   integration, etc.) with timestamp, actor, action type, metadata.
2. Surface a filterable in-product viewer (user, action type, date,
   project, severity, outcome, correlation, IP, latency).
3. Produce a traceable sequence of actions leading up to a failure, so
   on-call can reconstruct what happened.
4. Retain rows ≥ 90 days, exportable for compliance review.

Two existing components were proposed as candidates to extend instead
of building a new table:

- **An existing logging stub** — lives in a separate internal repo.
  The team's own assessment was that it was not comprehensive enough.
  Project-scoped, narrow event coverage, no retention contract, no
  immutability, no export.
- **`ProjectActivity`** — Prisma model in this repo. Project-scoped
  (`projectId` is `NOT NULL`), captures `document_created`,
  `context_added`, etc. Has no severity, no outcome, no correlation
  ID, no taxonomy, no retention, no failure-handling.

Beyond these two, the operational app log stream (`@repo/logs` ->
consola -> Datadog/Sentry) was also offered as a "we already have
this — just point a UI at it" option.

## Decision

Build a dedicated `AuditLog` Prisma model. Do not extend
`ProjectActivity`. Do not point an in-product UI at the operational
log stream. Keep the audit log small, indexed, immutable at the
application layer, customer-visible.

## Forces considered

### Volume vs retention

Operational logs are high-volume (~10k+ rows/sec for a busy app) and
ephemeral (days of retention at most). Audit events are low-volume
(~100 rows/day per active user) and long-lived (≥ 90-day retention
floor, with regulated industries pushing toward years).

A table sized for operational log volume hits unbounded storage at
90-day retention. A table designed for audit-log volume cannot ingest
operational logs without dropping rows or paying for storage
proportional to debug noise, not to compliance signal.

The two cannot share a table.

### Access pattern

Operational logs are queried by SREs grepping for stack traces, time
ranges, hostnames. Audit logs are queried by customer admins
filtering on **their** user, action type, project, date range — they
need a low-cardinality structured query with composite indexes
matching the filter surface.

These access patterns demand different schemas: loose JSON for logs
vs. typed columns + closed taxonomy for the audit log.

### Customer visibility

Customer admins must be able to read their own audit log through a
product surface. We cannot point them at Datadog or Sentry — those
contain other customers' data and aren't built for tenant-scoped
RBAC. The audit log must live in our app DB, behind our normal
multi-tenant filtering, with RLS as defense in depth.

### Immutability + tamper protection

Compliance frameworks (SOC 2 CC7.2, NIST 800-53 AU-9) expect audit
records to be append-only and tamper-evident. We enforce append-only
at the application layer (no procedure issues `UPDATE` or `DELETE`
outside the retention worker). Tamper-evidence (hash chain / signing)
is deferred — Postgres WAL + the trust model of the database admin
suffices for v1, and we will reconsider when adding SIEM forwarding.

The operational log stream has no immutability guarantee — it's
designed for SREs to mute, redact, and re-index.

### Extending `ProjectActivity` would require:

- Making `projectId` nullable (for auth + org + integration events
  that have no project).
- Adding `severity`, `outcome`, `correlationId`, `ipAddress`,
  `userAgent`, `sessionId`, `durationMs` columns.
- Adding three composite indexes for the filter surface.
- Defining a closed taxonomy for `activityType`.
- Adding a retention worker.
- Updating every existing `ProjectActivity` consumer (activity feed
  UX) to handle org-scoped + auth-scoped rows it never expected.

That is essentially building a new table, sharing its name with an
unrelated UX feature. Bad signal-to-noise.

### The existing logging stub

Lives in a separate internal repo, and the team's own pre-mortem
flagged it as inadequate. A net-new model in this repo, scoped to
compliance semantics, was simpler than negotiating a contract with a
stub that was not comprehensive enough.

## Consequences

### Positive

- Customer admins read their own audit log through the in-product
  viewer with tenant-scoped RBAC, RLS, and a typed filter surface.
- The audit log is small and indexed — composite indexes on
  `(organizationId, createdAt DESC)`, `(userId, createdAt DESC)`,
  `(action, createdAt DESC)`, `(projectId, createdAt DESC)` cover
  every filterable query in single-digit milliseconds at expected
  scale.
- Append-only semantics + closed taxonomy make compliance review easy
  to talk about with auditors.
- The operational log stream stays free to do its job (high-volume
  debug observation) without compliance constraints distorting its
  design.
- Failures route through the automatic error-capture middleware → one
  `error.*` audit row per failure, with stack trace + fingerprint +
  cause chain. Operators get post-incident reconstruction "for
  free".

### Negative

- Two write surfaces for "what happened": one logical event can fan
  out to the operational log AND the audit log. Mitigated by binding
  both with the same `correlationId` (via `AsyncLocalStorage` set in
  `asyncCorrelationMiddleware`), so an SRE can pivot freely between
  Datadog and the audit log.
- New maintenance surface: closed taxonomy must be extended every
  time a new significant action is added. Mitigated by an
  `as const` array + runtime validation in `buildAuditRow` that
  rejects typos.
- Storage cost grows linearly with audited-action volume. Mitigated
  by:
  - A short keep-by-default retention (90 days) configurable upward.
  - The `RequestSpan` table absorbs deep-trace storage on failure
    only, NOT on every request.
  - Compliance-driven retention extensions are a customer choice and
    a customer cost.

### Neutral

- We do not implement hash-chaining or signing in v1. We will
  reconsider when adding SIEM forwarding or when a customer
  contractually requires tamper-evidence (whichever comes first).
- The decision binds `AuditLog` to Postgres (the app DB). A future
  separate audit-log database is possible but not necessary at
  current scale.

## References

- [`../audit-log/README.md`](../audit-log/README.md) — index of the
  feature's canonical documentation.
- [`../audit-log/architecture.md`](../audit-log/architecture.md) — operational reference.
- [`../audit-log/api.md`](../audit-log/api.md) — public REST surface.
- [`../audit-log/client-tools.md`](../audit-log/client-tools.md) —
  staff workflow for cross-tenant reads via API key.
- NIST 800-53 AU control family — audit + accountability requirements.
- OWASP Logging Cheat Sheet — separation of audit logs from
  operational logs.

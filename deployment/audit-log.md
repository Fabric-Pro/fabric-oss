# Audit Log — Operator Guide

Operator-facing notes for deploying, configuring, and verifying the
comprehensive audit log feature. For engineering-facing detail (helpers,
emission contract, taxonomy) see `AGENTS.md`'s **Audit Log** section and
the spec at `docs/audit-log/README.md

## What the feature does

Every security-relevant action — login, logout, MFA changes, org-member
invites, project-member role changes, story create/delete, settings
changes — writes one row to the `audit_log` Postgres table.
Organization owners and admins can read the trail at
`/app/<orgSlug>/settings/audit-log`. Every user can read their personal-
context events (auth, MFA) at `/app/settings/audit-log`. CSV and NDJSON
exports are available from the viewer for compliance hand-off.

## Environment variables

Three new variables. All are server-side only; none are `NEXT_PUBLIC_*`.

### `FABRIC_DEPLOYMENT_ADMIN_EMAILS`

- **Default:** empty
- **Type:** comma-separated email list
- **Purpose:** every address in this list bypasses the
  `ORG_AUDIT_LOG_READ` / `ORG_AUDIT_LOG_EXPORT` permission AND the
  organization-membership check. Used by Fabric SRE to diagnose
  remote deployments without being added as a member of every customer
  org.
- **Cloud value:** your operations team's distribution list (e.g.
  `sre@example.com`).
- **Self-hosted value:** typically empty. Set only if a centralized
  ops team needs cross-org read access without org membership.
- **Security implications:** each address in this list is effectively a
  super-admin for the audit-read path. The bypass cannot be revoked
  through the UI — only by editing the env var and restarting. Audit-
  read events emitted by these users still show `actor.email`, so the
  trail of who-read-what is preserved.

### `FABRIC_AUDIT_LOG_RETENTION_ENABLED`

- **Default:** `false`
- **Type:** boolean string (`"true"` / `"false"`)
- **Purpose:** master switch for the Temporal scheduled workflow that
  purges expired audit rows. When `false`, the schedule is **not
  registered** at worker boot — re-enabling requires a worker restart.
- **Cloud value:** `true`. Cloud has a 365-day retention policy.
- **Self-hosted value:** `false` (default) preserves audit history
  forever. Operators who want bounded growth set this to `true`.

### `FABRIC_AUDIT_LOG_RETENTION_DAYS`

- **Default:** `0` (retain forever)
- **Type:** integer
- **Purpose:** rows older than `now() - N days` are deleted by the
  daily purge workflow. Only applies when
  `FABRIC_AUDIT_LOG_RETENTION_ENABLED=true`.
- **Cloud value:** `365`
- **Self-hosted recommended:** `365` for orgs that want bounded growth;
  `0` (the default) for orgs that want indefinite retention.
- **Warning band:** values between 1 and 89 (inclusive) emit a non-fatal
  startup log warning because compliance-sensitive customers
  expect at least 90 days of trail. Set deliberately or stick to 0/365.

### `FABRIC_AUDIT_ERROR_CAPTURE_DISABLED` (D16)

- **Default:** `false`
- **Type:** boolean string (`"true"` / `"false"`)
- **Purpose:** master kill switch for the automatic error-capture
  middleware. When `"true"`, no `error.*` rows are written to
  `audit_log` for ANY procedure throw. Use only as a temporary
  panic-button while diagnosing high-volume capture issues; the
  default-on capture is otherwise much cheaper than the lost forensic
  trail.
- **Cloud value:** unset (`false`).
- **Self-hosted recommendation:** unset (`false`). Re-evaluate only if
  a buggy procedure floods the table.

### `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS` (D16)

- **Default:** empty (no skips)
- **Type:** comma-separated procedure paths
- **Purpose:** suppress `error.*` capture for specific procedure paths.
  An entry like `internal.health` is an exact match; an entry like
  `internal.*` is a prefix match (trailing `*`). Use to silence
  high-cardinality / known-noisy procedures.
- **Example:** `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS="health.ping,debug.*"`
- **Cloud value:** unset.
- **Self-hosted recommendation:** unset by default. Add entries only
  when a specific path proves chatty.

### `FABRIC_PUBLIC_API_DOCS_ENABLED`

- **Default:** `false`
- **Type:** boolean string (`"true"` / `"false"`)
- **Purpose:** controls whether `GET /api/v1/docs` serves a Swagger
  (Scalar-themed) UI for the public audit-log REST API. The endpoints
  themselves (`GET /api/v1/audit-log`, `GET /api/v1/audit-log/export`)
  work in every environment regardless of this flag — only the docs UI
  is gated.
- **Why gate the docs at all?** Production deployments minimize public
  surface area. Staging shows the docs so SREs can use the live UI to
  experiment; prod requires the caller to already know the URL +
  scopes.
- **Cloud staging value:** `true`. Operators use
  `https://<your-staging-host>/api/v1/docs` to construct curls.
- **Cloud production value:** unset (`false`). The endpoints work; the
  Swagger UI returns 404. The `/api/v1/openapi.json` route is also
  gated off in this mode so the OpenAPI schema is not advertised.
- **Self-hosted recommendation:** `true` if you want operators to have
  a built-in docs surface; `false` otherwise.
- **Vercel staging operator note:** `.env.staging.example` lists this
  flag, but committing it to the example file does **not** apply the
  value on your hosted staging deployment. Vercel reads env vars from the
  project's Settings → Environment Variables (scoped to the Preview /
  Production environment used by the staging deployment). After
  merging the example file, set `FABRIC_PUBLIC_API_DOCS_ENABLED=true`
  in the Vercel dashboard for the staging environment and redeploy.
  When the flag is missing, hitting `/api/v1/docs` returns a friendly
  404 HTML page that names the exact env var to set (see
  `packages/api/index.ts` — the `/v1/docs` handler).

## Public audit-log REST API

The public REST surface is documented in detail in `AGENTS.md` (search
for "Public REST API"). Key operator notes:

- **HTTPS only in production.** API keys are bearer credentials. Plain
  HTTP transport would let any on-path observer steal them.
- **No CORS.** The Hono routes do NOT advertise `Access-Control-Allow-
  Origin: *`. A browser running on an attacker-controlled origin
  cannot reach these endpoints even with a stolen key.
- **Rate limit:** 600 req/min per key (`auditExternal` preset in
  `packages/api/lib/rate-limit.ts`). Tune via PR if a real consumer
  exceeds this with legitimate traffic.
- **Audit trail:** every authenticated call emits a fresh
  `audit.api_request` row sampled at 100%. The trail carries the key
  prefix and matched endpoint — never the raw key. Operators can
  filter the audit table on `category=audit` + `action=audit.api_request`
  to see who consumed each key.

### Performance at scale

The REST endpoints share the underlying queries (`listAuditLog`,
`fetchAuditLogForExport`, `countAuditLog`) with the in-product viewer.
The composite indexes on `audit_log` cover all filter dimensions; the
`actorEmailContains` / `ipAddressContains` substring matches use Postgres
`ILIKE` and are fine up to roughly 1M rows. Beyond that point a
`pg_trgm` GIN index on `actorEmailSnapshot` and `ipAddress` becomes the
preferred plan — add this to the pre-deploy checklist before any
deployment expecting >1M audit-log rows.

## Deployment steps (Fabric Cloud)

1. Set the three env vars on Cloud (production / staging both):

   ```bash
   FABRIC_DEPLOYMENT_ADMIN_EMAILS="sre@example.com"
   FABRIC_AUDIT_LOG_RETENTION_ENABLED="true"
   FABRIC_AUDIT_LOG_RETENTION_DAYS="365"
   ```

2. Apply the Prisma migration to the production database:

   ```bash
   npx dotenv -c -e ../../.env.production -- \
     npx prisma migrate deploy --schema=./prisma/schema.prisma
   ```

3. Apply the RLS policy (idempotent — re-running is safe):

   ```bash
   pnpm --filter @repo/database apply:rls
   ```

4. Restart the Temporal worker so the retention schedule is registered:

   ```bash
   # From Aspire dashboard or via MCP
   # Resource: temporal-worker, Command: resource-restart
   ```

5. Confirm the schedule appears:

   ```bash
   temporal schedule list
   # Expect a row named "audit-log-retention" with a 24h interval
   ```

## Deployment steps (self-hosted)

The audit log writes happen automatically once the migration is applied.
Reads are gated by the same RBAC the rest of the org settings use, so
nothing further is required for the viewer to be usable.

To enable the retention purge:

```bash
FABRIC_AUDIT_LOG_RETENTION_ENABLED="true"
FABRIC_AUDIT_LOG_RETENTION_DAYS="365"   # or whatever your policy requires
```

Then restart the Temporal worker. Without this step, audit rows
accumulate forever — for low-volume self-hosted instances this is
typically fine.

## Verifying the deployment

Quick smoke check (5 minutes):

1. Log in to staging as an org owner.
2. Navigate to `/app/<slug>/settings/audit-log`. Expect:
   - The viewer renders with at least one row (your `auth.login.success`
     event).
   - A sidebar entry titled **Audit Log** is present.
3. Click **Export**, choose **Export as CSV**. Expect a file named
   `audit-log-<orgId>-<ISO>.csv` to download with a header row.
4. Log in to staging as a `member` or `viewer` role user. Navigate to
   the same URL. Expect:
   - The forbidden panel ("Access required") renders.
   - The sidebar entry is **not** visible.

## Retention purge — how to verify

The workflow is named `audit-log-retention` and runs every 24 hours by
default. To verify:

1. `temporal schedule list` shows the schedule.
2. `temporal schedule describe audit-log-retention` shows the last and
   next scheduled run.
3. After a run, the trail itself contains an
   `audit.retention.purged` event with
   `metadata.deletedCount` and `metadata.cutoffAt`.

Manual trigger (e.g. for staging perf test cleanup):

```bash
temporal schedule trigger audit-log-retention
```

If `RETENTION_DAYS=0`, the activity returns `deletedCount: 0` and does
**not** emit `audit.retention.purged` (the workflow short-circuits on
retain-forever).

## The "90-day warning" — what it means

If `FABRIC_AUDIT_LOG_RETENTION_DAYS` is between 1 and 89, the worker
logs a structured warning at startup. This is intentional: compliance-sensitive
and regulated customers expect at least 90 days of
audit history for forensic correlation. Values outside that band
suggest a misconfiguration or a deliberate operator choice — the warning
is non-fatal and the worker continues. To clear it, set `RETENTION_DAYS`
to `0` (retain forever) or to a value `>= 90`.

## Observability

- **Counter:** `fabric_audit_write_failures_total` increments when the
  helper fails to write a row (most likely a transient DB error). Watch
  this in Grafana — sustained rate > 0 is a real incident.
- **OTEL traces:** `audit.list`, `audit.export`, and `audit.taxonomy`
  procedures are auto-instrumented by the oRPC tracing middleware. The
  `audit.list` p95 SLO is 300ms; see
  `docs/audit-log/README.md`
  for the load assumptions behind that target.
- **Retention workflow:** the daily purge logs `deletedCount` /
  `cutoffAt` on every run. Failures are retried twice (per
  `spec.md §9.2`) and then surface in Temporal's failed-workflow
  monitoring.

## Rollback

The migration is forward-only. Rollback is `prisma migrate resolve
--rolled-back add_audit_log_table` plus a manual `DROP TABLE
"audit_log" CASCADE`. Audit data is **lost** on rollback — there is no
"data preservation" path. Since no read or write path depends on the
table existing before this feature shipped, that is acceptable.

## Tracing a request flow by correlation ID

Every request is tagged with a correlation ID (see AGENTS.md "Correlation
ID flow"). The ID lands on each `audit_log.metadata.correlationId` for
rows emitted during that request. To diagnose:

1. **Find any audit row.** Open the org settings → Audit Log page,
   identify the row of interest (typically an `error.*` row), and click
   to open the metadata drawer.
2. **Copy the correlation ID.** Top of the drawer, click the clipboard
   button.
3. **Paste into the filter chip** ("Correlation ID" input in the
   toolbar). The table now shows every audit row from that single
   request — typically an auth check, the business mutation, and the
   error capture.
4. **Cross-reference with logs.** The same ID appears in every
   structured log line from that request (search `correlationId="<id>"`
   in your log aggregator). Outbound calls made during the request
   propagate the ID via the `X-Correlation-ID` header.

## Verifying the incident bridge (D17)

The bridge mirrors every `IncidentEvent` row into one `audit_log` row.
To smoke-test after a deploy:

1. Trigger an incident transition (e.g. acknowledge an open
   ErrorRateIncident via the admin UI).
2. Confirm an audit row appears with `action: "incident.acknowledged"`,
   `category: "incident"`, the actor matching the acknowledger, and
   `metadata.incidentEventId` pointing at the new IncidentEvent row.
3. For Alertmanager paths (FIRED / RE_FIRED / AUTO_RESOLVED), check the
   audit row's `actor.type` is `"system"` and that
   `metadata.correlationId` is the Temporal workflow runId.

If the bridge appears silent, check:
- The IncidentEvent row was actually inserted (query
  `incident_event` for the lifecycle event in question).
- The Alertmanager-driven path uses
  `packages/database/prisma/queries/incidents.ts:upsertAlertmanagerIncident`,
  the Temporal poller uses
  `packages/temporal/src/activities/monitoring/upsert-integration-incident.ts`,
  and both should land an audit row. If only one does, the bridge
  wiring was reverted.

## Where to look when things go wrong

- "I get a 403 on the audit-log page" → check the user's org role.
  Only `owner` and `admin` can read. Personal page has no gate.
- "The Export button is disabled" → no rows match the current filter.
  Widen the date range.
- "I don't see my recent action" → there is no real-time push;
  refresh. Writes go through `setImmediate` so they may lag a request
  by tens of milliseconds. The trail is eventually consistent.
- "The retention workflow didn't fire" → check
  `FABRIC_AUDIT_LOG_RETENTION_ENABLED` is `"true"` (the string, not
  unset) and that the Temporal worker has been restarted since the
  env var was set.

## Related files

- `docs/audit-log/README.md — full spec
- `docs/audit-log/README.md` — design decisions
- `docs/audit-log/README.md` — load assumptions
- `docs/audit-log/README.md` — pre-flight
- `AGENTS.md` — engineering-facing helper documentation (Audit Log section)
- `packages/temporal/src/workflows/audit-log-retention.ts` — retention workflow
- `packages/database/prisma/queries/audit-log.ts` — `recordAudit` and the taxonomy const

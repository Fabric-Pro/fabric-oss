# Audit Log Architecture

Data model, emission helpers, redactor, retention, request-span trace
capture on failure, performance characteristics.

- **Audience**: Developers extending the audit log or wiring new emitters
- **Owner**: Platform / SRE

## Data model

The `AuditLog` table is the canonical compliance ledger. One row per
significant actor-driven event. Append-only at the application layer
(no procedure ever updates or deletes a row outside the retention
worker).

```
+------------------+         +------------------------+
|    AuditLog      |         |     RequestSpan        |
|------------------|         |------------------------|
| id (cuid)        |         | id (cuid)              |
| correlationId    +-------->+ correlationId (idx)    |
| organizationId   |    1..* | organizationId         |
| userId           |         | userId                 |
| actorType        |         | kind (db | temporal_*  |
| actorEmail/Name  |         |   | http_outbound)     |
| action (taxonomy)|         | name                   |
| category         |         | startedAt              |
| severity         |         | durationMs             |
| outcome          |         | status                 |
| resourceType/Id  |         | attributes (JSON)      |
| projectId        |         | errorMessage           |
| ipAddress        |         | createdAt              |
| userAgent        |         +------------------------+
| sessionId        |         (persisted ONLY on failure)
| metadata (JSON)  |
| durationMs       |
| createdAt        |
+------------------+
```

Indexes — composite on `(organizationId, createdAt DESC)`,
`(userId, createdAt DESC)`, `(action, createdAt DESC)`,
`(projectId, createdAt DESC)`. `correlationId` trace lookups run as a
Prisma JSON-path filter over the `metadata` column; a partial GIN index
is explicitly deferred to a later phase.

### Why a dedicated table

Audit events have different characteristics from operational logs:

| Property | App logs (consola / Datadog) | Audit log |
|---|---|---|
| Volume | High (10k+ rows/sec) | Low (~100 rows/day/active user) |
| Retention | Days | ≥90 days (compliance floor) |
| Mutability | Ephemeral | Append-only |
| Access | Staff / SREs | Admins + customer themselves |
| Schema | Loose | Tight closed taxonomy |

See [ADR-006](../adr/006-audit-log-separate-table.md) for the full
decision record. An existing logging stub (in a separate internal repo)
and `ProjectActivity` could not be extended to serve the audit-log
purpose without compromising one or both surfaces.

## Closed taxonomy

`AUDIT_ACTIONS` (in `packages/database/prisma/queries/audit-log.ts`) is
an `as const` array of 56+ action keys grouped by category prefix:

- `auth.*` — login, logout, MFA, impersonation, password
- `org.*` — organization + member + API key + integration lifecycle
- `account.*` — personal API key lifecycle
- `project.*`, `story.*` — project + feature management
- `audit.*` — viewer + export + retention + REST API requests
- `admin.*` — staff-only actions (e.g. `admin.auditLog.viaApiKey`)
- `incident.*` — bridge from `IncidentEvent` lifecycle (state transitions only)
- `error.*` — open-namespace, populated by the automatic error-capture middleware

Any action not in the closed set still persists, but `buildAuditRow`
emits an `audit.unknown_action` warning log so a typo surfaces in
observability rather than failing the write.

## Emission helpers

Two patterns, both in `packages/database/prisma/queries/audit-log.ts`:

| Helper | Use when |
|---|---|
| `recordAudit(input)` | Default for procedure handlers + Temporal activities. Fire-and-forget — returns `void` synchronously. Failures route through `onAuditWriteFailure` (structured log + counter + stdout fallback). |
| `recordAuditTx(tx, input)` | When the audit row must commit/roll back atomically with another mutation. Accepts a Prisma transaction client and awaits the insert. Errors propagate. |

Both helpers run the metadata redactor unconditionally before insert
(see below). Callers are NOT trusted to redact themselves.

### Automatic error capture

`packages/api/orpc/middleware/audit-error-middleware.ts` wraps every
oRPC procedure call. When an `ORPCError` is thrown, the middleware
records an `error.*` audit row with the action mapped from the error
code, severity from the classifier, the cleaned stack trace, the
fingerprint (`sha256(type | code | topFrame)`), and the full cause
chain. Zero per-callsite work — every existing and future procedure is
covered.

### Automatic latency capture

`packages/api/orpc/middleware/audit-timing-middleware.ts` opens a
timing frame via `AsyncLocalStorage` before the procedure runs and
closes it on completion. `recordAudit` reads the elapsed value via
`getAuditTimingDurationMs()` and stores it in the row's `durationMs`
column. The success path drops the timing frame with zero cost.

## Sensitive-key redactor

`redactSensitiveKeys` runs at write time on every metadata payload.
Match is on the KEY name (case-insensitive substring), not the value —
a non-sensitive key whose value looks like a secret is preserved, and
a sensitive key with a benign value is still redacted.

Denylist (extend in `audit-log.ts` — no migration required):

```
password, passwd, pass, token, accesstoken, refreshtoken,
idtoken, bearer, apikey, api_key, secret, clientsecret,
cookie, authorization, pin, cvv, ssn
```

When a key matches, the entire value is replaced with `"[REDACTED]"` —
including nested objects and arrays — so a recursive walk never leaks
a secret nested deeper.

> **Naming note**: the REST middleware deliberately uses `keyPrefix` /
> `keyId` (not `apiKeyPrefix` / `apiKeyId`) when emitting
> `audit.api_request` rows, so the redactor does not strip the
> operator-visible identifiers. The prefix is non-secret by design (12
> chars, can't authenticate); the keyId is a CUID already exposed via
> the management UI.

## Tail-sampled request-span capture

The `RequestSpan` table captures deep observability spans (DB queries,
Temporal workflow / activity events, outbound HTTP calls) buffered
per-request in `AsyncLocalStorage` and persisted **ONLY on failure**.

- The success path drops the buffer with zero DB writes — the audit
  log stays clean, the storage cost stays proportional to the failure
  rate (≈ 1% of total traffic in practice).
- Buffer cap: 200 spans per request, enforced in the buffer helper.
- TTL: 7 days, enforced by the Temporal retention activity (mirrors
  the audit-log retention pattern).
- The trace panel in the row drawer fetches via `audit.tracedRequest`,
  which returns audit rows + spans interleaved by timestamp.

Wiring:

- Prisma `$use` middleware → buffers `kind: "db"`.
- Temporal `WorkflowInboundCallsInterceptor` +
  `ActivityInboundCallsInterceptor` → buffer `kind: "temporal_*"`.
- `recordAuditFromRequest` → flushes the buffer when the request
  outcome is `failure`, drops it when `success`.
- REST middleware in `audit/rest/routes.ts` → flushes if response
  status ≥ 400.

## Retention

The default retention floor is 90 days. Cleanup is opt-in:

- `FABRIC_AUDIT_LOG_RETENTION_ENABLED=true` (default `false`)
- `FABRIC_AUDIT_LOG_RETENTION_DAYS=90` (default `90`)

When enabled, a Temporal scheduled workflow
(`packages/temporal/src/workflows/audit-log-retention.ts`) runs daily,
batched-deletes rows older than the threshold, and emits an
`audit.retention.purged` row capturing the deleted count.

`RequestSpan` rows are purged on a separate, shorter schedule (7-day
default).

## Tamper-evidence: append-only (WORM) + cryptographic sealing

Two layers protect the integrity of the trail (SOC 2 CC7.1/CC7.2):

**1. Append-only (WORM) — always on.** A row-level `BEFORE UPDATE OR DELETE`
trigger (`audit_log_worm`, migration `20260702130000`) rejects every UPDATE
(except the FK `ON DELETE SET NULL` transition of `userId` / `organizationId` /
`projectId`) and every DELETE that has not opted into the retention bypass GUC
(`SET LOCAL app.audit_allow_delete = 'on'`, set only by the retention activity).
Because it is a trigger, it binds every role — including the table owner and
superusers — so the log is immutable through normal database access.

**2. Cryptographic sealing — opt-in.** The WORM trigger protects the log *while
it is intact*; it cannot, on its own, prove after the fact that nobody with
direct database ownership dropped the trigger, edited rows, and restored it.
Sealing closes that gap using the AWS-CloudTrail log-file-validation model:

- An hourly Temporal schedule (`audit-log-seal`, registered only when
  `FABRIC_AUDIT_LOG_SEALING_ENABLED=true`) computes a **seal** over the
  immutable content of every audit row in a time window, **chains** it to the
  previous seal, and **HMAC-signs** it with a key held *outside* the database.
- The seal covers every immutable column but deliberately **excludes**
  `organizationId` / `userId` / `projectId` — the three columns the WORM trigger
  lets transition to NULL on referent deletion — so a legitimate org deletion
  never raises a false tamper alarm. Their integrity is enforced by the trigger.
- Seals live in `audit_log_seal`, itself append-only (own `audit_log_seal_worm`
  trigger). Sealing runs off the insert hot path, so `recordAudit` stays fast.
- **Signing key**: `AUDIT_LOG_SIGNING_KEY` (preferred; from Secrets Manager /
  Key Vault) or, with zero config, a key HKDF-derived from `BETTER_AUTH_SECRET`.
  Each seal records a non-secret `keyId` (algorithm + fingerprint) so keys
  rotate non-destructively — set `AUDIT_LOG_SIGNING_KEY_PREVIOUS` during a
  rotation and old seals still verify.
- **Lag**: only rows older than `FABRIC_AUDIT_LOG_SEAL_LAG_SECONDS` (default
  300) are sealed, so in-flight inserts land before their window closes.

### Provisioning and rotating the signing key

The dedicated key is provisioned in Azure Key Vault as `audit-log-signing-key`
(with `audit-log-signing-key-previous` as its rotation partner) and injected into
the Temporal worker as `AUDIT_LOG_SIGNING_KEY` / `AUDIT_LOG_SIGNING_KEY_PREVIOUS`
(`deployment/azure/main.bicep`). GitHub Secrets are the source of truth: the
`sync-keyvault-secrets` CI job writes real values into Key Vault on each deploy
and rolls the worker onto a fresh revision. Until a real value is set the entry
stays at the `"placeholder"` written by the deploy pre-populate step — the worker
runs and seals, but keeps using the `BETTER_AUTH_SECRET`-derived fallback below.

**Initial provisioning** (per environment — dev, staging, prod):

1. Generate a high-entropy key: `openssl rand -base64 32`.
2. Set it as the `AUDIT_LOG_SIGNING_KEY` GitHub environment secret for that
   environment. Leave `AUDIT_LOG_SIGNING_KEY_PREVIOUS` unset until a rotation.
3. Trigger a deploy. `sync-keyvault-secrets` writes the value to Key Vault and
   rolls the worker; from the next hourly seal onward `keyId` reflects the
   dedicated key instead of the `BETTER_AUTH_SECRET`-derived fingerprint.
4. Confirm with `pnpm --filter @repo/database verify:audit-seals:<env>` — it
   exits 0, verifying both old (HKDF-fallback) and new (dedicated-key) seals.

> **Avoid an interim `"placeholder"` gap.** Because `"placeholder"` is a *non-empty*
> value, once the wiring deploys the sealer signs new seals with it (deterministic,
> publicly known → no real tamper-evidence) rather than the HKDF fallback. Prefer
> setting the real GitHub Secret in the *same* deploy that ships this wiring, so no
> seal is ever signed under `"placeholder"`. If seals were already written under it,
> set `AUDIT_LOG_SIGNING_KEY_PREVIOUS="placeholder"` alongside the first real key so
> those interim seals keep verifying, then clear it once they have been re-verified.

**Rotation** (non-destructive):

1. Set `AUDIT_LOG_SIGNING_KEY_PREVIOUS` to the *current* value of
   `AUDIT_LOG_SIGNING_KEY`.
2. Set `AUDIT_LOG_SIGNING_KEY` to a freshly generated value.
3. Deploy. New seals sign with the new key; old seals resolve via the `-previous`
   candidate, so `verify:audit-seals` stays green throughout.
4. Once every seal predating the rotation has been re-verified, you may clear
   `AUDIT_LOG_SIGNING_KEY_PREVIOUS`. Clearing it *before* those seals are verified
   makes them fail with `KEY_UNAVAILABLE`.

**Non-destructive fallback guarantee.** `BETTER_AUTH_SECRET` remains available as
the third key candidate, so seals written before any dedicated key was provisioned
keep verifying without a backfill or re-seal. Never roll a dedicated key back to
`"placeholder"` once real seals exist under it — use the `-previous` slot instead.

Verify the chain on demand — the tool an auditor runs to prove the trail is
intact — with:

```
pnpm --filter @repo/database verify:audit-seals            # local
pnpm --filter @repo/database verify:audit-seals:staging    # staging
pnpm --filter @repo/database verify:audit-seals:prod       # production
```

It re-derives every seal from the current rows and reports the first failure
(modified / inserted / deleted row, broken chain, forged seal, or missing key),
exiting non-zero. Design + crypto: `prisma/queries/audit-log-seal.ts`.

## Multi-tenant isolation

Every read uses the standard XOR pattern:

```ts
// Org context
{ organizationId: orgId, userId: null }
// Personal context
{ organizationId: null, userId: callerId }
```

The REST verifier derives the scope from the API key itself
(`org_*` → org, `fab_*` → personal); query-string `organizationId`
parameters are NOT accepted on the public surface. RLS policies
applied via `pnpm --filter @repo/database apply:rls` enforce isolation
at the database layer as a defense in depth.

## Performance characteristics

| Op | Cost |
|---|---|
| `recordAudit` synchronous call | Single allocation (input object) + microtask schedule. |
| Async insert | One row plus its composite btree index updates. ≈ 1 ms p99 in dev. |
| `audit.list` page query | One `findMany` keyset paginated on `(createdAt, id)`. ≈ 5 ms p99 for 50-row pages over 90-day data. |
| `audit.tracedRequest` join | Two `findMany`s by `correlationId` (audit + spans), merged client-side. Cap 200 spans + reasonable audit count → no N+1. |
| `RequestSpan` buffer on success | Zero DB writes. The buffer is local memory; the originating procedure never awaits an insert. |
| Composite-index hit ratio | All filterable columns (`action`, `actorId`, `projectId`, `createdAt`) are covered. |

## File map (load-bearing entry points)

- `packages/database/prisma/schema.prisma` — `AuditLog`, `AuditLogSeal`, `RequestSpan` models
- `packages/database/prisma/queries/audit-log.ts` — taxonomy, helpers, redactor
- `packages/database/prisma/queries/audit-log-seal.ts` — seal crypto (canonicalize, hash, sign, verify, key rotation)
- `packages/database/prisma/queries/audit-log-seal-store.ts` — DB orchestration (`sealNextAuditWindow`, `verifyAllAuditSeals`)
- `packages/database/scripts/verify-audit-seals.ts` — on-demand chain verifier (`verify:audit-seals`)
- `packages/temporal/src/{activities,workflows}/audit-log-seal.ts` — hourly sealing schedule
- `packages/database/prisma/queries/component-incidents.ts` — incident bridge
- `packages/api/orpc/middleware/audit-error-middleware.ts` — auto error capture
- `packages/api/orpc/middleware/audit-timing-middleware.ts` — latency capture
- `packages/api/lib/audit.ts` — `recordAuditFromRequest`, observability wiring
- `packages/api/lib/request-span.ts` — span buffer + flush helpers
- `packages/api/modules/audit/` — oRPC procedures (list, export, stats, taxonomy, tracedRequest)
- `packages/api/modules/audit/rest/` — public REST surface
- `apps/web/modules/saas/settings/components/audit-log/` — viewer components

## Related docs

- [`README.md`](./README.md) — index of the feature's documentation.
- [`api.md`](./api.md) — public REST surface.
- [`client-tools.md`](./client-tools.md) — staff workflow for
  cross-tenant reads via API key.
- [`../adr/006-audit-log-separate-table.md`](../adr/006-audit-log-separate-table.md)
  — the decision to use a dedicated table rather than extend the
  operational log stream or `ProjectActivity`.

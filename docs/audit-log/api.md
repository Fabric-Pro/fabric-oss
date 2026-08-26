# Audit Log REST API

Public REST surface for reading and exporting audit-log events from
outside the Fabric web app — for customer scripts, our CLI, SDKs, or
the staff "Audit Log Explorer".

- **Audience**: Customer integrators, Fabric staff scripting against the API
- **Owner**: Platform / SRE

## Endpoints

| Method + Path | Scope | Purpose |
|---|---|---|
| `GET /api/v1/audit-log` | `audit_log:read` | Paginated list with filters |
| `GET /api/v1/audit-log/export` | `audit_log:export` | Full export (CSV or NDJSON), 50k-row cap |
| `GET /api/v1/system-health` | `system_health:read` | Component status + active announcements for the key's tenant |
| `GET /api/v1/status-updates` | `status_updates:read` | Published status announcements and their history |
| `GET /api/v1/docs` | none (env-gated) | Interactive Scalar UI |
| `GET /api/v1/openapi.json` | none (env-gated) | Raw OpenAPI 3 spec |

The two system-health endpoints share this API's authentication, rate limit and
error vocabulary. They are scoped separately because `system-health` includes the
tenant's **own** signals (their recent failure rate, their connection health)
while `status-updates` carries only platform announcements and nothing about the
workspace — so a monitor can be granted the latter without the former.

Every rejected request (bad key, revoked key, insufficient scope, rate-limited)
is recorded in the audit log with the key prefix, so a probing or misconfigured
integration is visible rather than silent.

The docs surface is gated by `FABRIC_PUBLIC_API_DOCS_ENABLED`. On in
local dev + staging; off in production by default so we don't advertise
the API surface publicly.

![Swagger UI](./assets/09-swagger.png)

## Authentication

Every read or export requires a Bearer token:

```
Authorization: Bearer <api_key>
```

Keys come in two flavors:

- `org_*` — created by an organization owner / admin in
  `Settings → Audit Log → Manage API keys`. Returns the org's full
  audit log.
- `fab_*` — created by a user in
  `Settings → Audit Log → Manage API keys` (personal context). Returns
  that user's personal audit log.

The key alone encodes the tenant — there is no separate `organizationId`
input on the public API. An `org_*` key cannot fetch another org's
rows, and a `fab_*` key cannot fetch another user's. Cross-tenant
access is impossible by construction.

### Scope restriction

Audit-log keys are scope-limited at creation time to
`audit_log:read` and / or `audit_log:export`. A key with these scopes
**cannot** reach any other API endpoint — the route verifier is mounted
only on `/api/v1/audit-log*`, and other routes use unrelated verifiers
with their own scope allowlists.

A leaked audit-log key cannot escalate to read agents, projects, or
chats.

### Rate limit

600 requests / minute / key. Standard headers returned on every
response:

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 599
X-RateLimit-Reset: 60
```

Over-limit responses are 429 with a `Retry-After` header.

## Filters

All filters are query-string parameters; all are optional.

| Param | Type | Example |
|---|---|---|
| `actions` | comma-separated string | `auth.login.success,auth.login.failure` |
| `categories` | comma-separated string | `auth,org` |
| `actorIds` | comma-separated string | `cmpaaldw4000xho5hubnh99dc` |
| `actorTypes` | enum array (`user`, `api_key`, `system`, `agent`) | `user,api_key` |
| `projectId` | string | `cmqxxx...` |
| `severities` | enum array (`info`, `warning`, `error`, `critical`) | `error,critical` |
| `outcomes` | enum array (`success`, `failure`) | `failure` |
| `dateFrom` | ISO 8601 | `2026-05-01T00:00:00Z` |
| `dateTo` | ISO 8601 | `2026-05-18T23:59:59Z` |
| `correlationId` | string | `req_abc...` |
| `ipAddressContains` | string | `192.0.2` |

Pagination on `/audit-log`:

- `limit` — 1–200, default 50.
- `cursor` — opaque string from the previous response's `nextCursor`.

The cursor is a base64-encoded `{ createdAt, id }` pair, keyed off the
last row of the previous page so subsequent pages remain stable even
when new rows arrive at the head.

## Example: list the last 5 events

```sh
curl -s \
  -H 'Authorization: Bearer org_bc52818d_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  'http://localhost:3001/api/v1/audit-log?limit=5'
```

Response:

```jsonc
{
  "items": [
    {
      "id": "cmpa6kir60033u85h9o4j5c6t",
      "organizationId": "cmp9zpkib00028s5hlmm1x13o",
      "userId": null,
      "actorType": "api_key",
      "actorNameSnapshot": "SRE laptop test",
      "action": "audit.api_request",
      "category": "audit",
      "severity": "info",
      "outcome": "success",
      "resourceType": null,
      "resourceId": null,
      "projectId": null,
      "ipAddress": "127.0.0.1",
      "userAgent": "curl/8.18.0",
      "sessionId": null,
      "metadata": {
        "endpoint": "/api/v1/audit-log",
        "method": "GET",
        "responseStatus": 200,
        "keyPrefix": "org_bc52818d",
        "keyId": "cmpa6dgn60020u85hsmxud4gq",
        "resultCount": 5,
        "correlationId": "req_mpa6kikg_r0k5ecrk"
      },
      "durationMs": 70,
      "createdAt": "2026-05-17T19:41:05.385Z"
    }
    // ...
  ],
  "nextCursor": "eyJjcmVhdGVkQXQi…",
  "totalCount": 1342
}
```

## Export

Synchronous response — the entire result set is streamed back as a
single body. Cap: 50 000 rows. Use filters to narrow if the count
exceeds the cap (HTTP 400 with a `Result set exceeds 50 000 rows`
message when over).

```sh
# CSV
curl -s \
  -H 'Authorization: Bearer org_bc52818d_xxxxxxxx' \
  'http://localhost:3001/api/v1/audit-log/export?format=csv&dateFrom=2026-05-01T00:00:00Z' \
  -o audit-log-2026-05.csv

# NDJSON (one JSON object per line)
curl -s \
  -H 'Authorization: Bearer org_bc52818d_xxxxxxxx' \
  'http://localhost:3001/api/v1/audit-log/export?format=ndjson' \
  -o audit-log.ndjson
```

The endpoint emits an `audit.api_request` row (visible in the audit
log itself) on every successful call, capturing the row count + format.

## Audit-of-the-audit-log

Every authenticated call emits one `audit.api_request` row (sampled at
100% in v1). Operators can grep for `actorType: "api_key"` to inventory
who hit which endpoint, when, with what filters, and what came back.
The key prefix is captured for forensic identification; the secret is
never persisted anywhere.

### Rejected calls, and which of them you can see

Rejected calls are audited too — a key being probed, replayed after revocation,
or hammered past the rate limit is precisely the forensic question asked first.
**Which tenant the row lands in follows what the request proved, not what it
claimed:**

| Rejection | Owner proven? | Where the row lands |
|---|---|---|
| `INSUFFICIENT_SCOPE`, `TOO_MANY_REQUESTS`, `SERVICE_UNAVAILABLE` | yes — the key authenticated | the owning tenant's log |
| `API_KEY_REVOKED`, `API_KEY_EXPIRED` | yes — the secret matched the stored hash before the state check | the owning tenant's log |
| `INVALID_API_KEY` (unknown prefix, or wrong secret), `MISSING_AUTHORIZATION`, `INVALID_API_KEY_FORMAT` | **no** | tenant-less; not readable through any scoped surface |

The last row is a deliberate limit, not an oversight. Attributing a rejection on
the strength of an unverified 8-hex prefix would let prefix-guessing write rows
into a stranger's audit trail. Those attempts are instead counted on the
`fabric_api_key_rest_unattributable_rejections_total` metric (labelled by error
code), which is the alertable signal for credential probing — a rising
`INVALID_API_KEY` rate is someone guessing.

## Errors

All errors follow:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable detail" } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Filter malformed (e.g. `dateFrom > dateTo`) or export cap exceeded |
| 401 | `MISSING_AUTHORIZATION` | No `Authorization` header |
| 401 | `INVALID_API_KEY_FORMAT` | Header malformed (missing `Bearer` prefix or unknown key shape) |
| 401 | `INVALID_API_KEY` | Hash mismatch or key not found (deliberately collapsed so probing reveals nothing) |
| 401 | `API_KEY_REVOKED` | Key was revoked |
| 401 | `API_KEY_EXPIRED` | Key passed its `expiresAt` |
| 403 | `INSUFFICIENT_SCOPE` | Key authenticated, but lacks the required `audit_log:read` / `audit_log:export` scope |
| 429 | `TOO_MANY_REQUESTS` | Rate-limit (600/min/key) tripped |
| 503 | `SERVICE_UNAVAILABLE` | Rate limiting is unavailable, so requests are refused. See below — this is often **not** transient. |

### A 503 is usually a misconfiguration, not a blip

Rate limiting fails **closed**: when the limiter cannot be consulted, requests
are refused rather than allowed through unmetered. There are two very different
causes, and only one of them clears on its own.

- **No rate-limit store configured.** In production the app requires
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Without them every
  request to this API returns 503 **permanently** — retrying will never succeed.
  This is the common failure in a fresh self-hosted deployment. The response
  body names the missing variables.
- **Store configured but unreachable.** A genuine transient; retry with backoff.

If you are standing up a self-hosted deployment and every call returns 503,
check the two environment variables before investigating anything else.

Also relevant when self-hosting: set `NEXT_PUBLIC_SITE_URL` (or `APP_URL`) so
the OpenAPI document advertises your own origin. The document otherwise falls
back to the request's origin, and older deployments could publish
`http://localhost:3000` — a port this app does not use by default.

## CORS

The endpoint serves NO CORS — these routes are server-to-server only.
A browser on a hostile origin cannot fish for audit data using a
stolen key. Customer browsers that need cross-origin access should
route through their own backend.

## Versioning

`/api/v1/*` is stable. Breaking changes will mount at `/api/v2/*` and
both will run in parallel for at least one major release. The
OpenAPI doc at `/api/v1/openapi.json` is the source of truth for the
contract.

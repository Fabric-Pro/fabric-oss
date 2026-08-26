# Fabric — Databricks Integration Guide

This guide covers optional support for running Fabric's PostgreSQL on **Databricks Lakebase** and the shared `@repo/databricks` auth package for workspace authentication.

---

## 1. Workspace authentication

These env vars identify and authenticate the Fabric service principal to the Databricks workspace. They are shared across all Databricks-backed features (Lakebase, and future phases).

| Env var | Description | Example |
|---|---|---|
| `DATABRICKS_HOST` | Workspace URL — `https://` required, no trailing slash | `https://adb-1234567890123456.7.azuredatabricks.net` |
| `DATABRICKS_CLIENT_ID` | Service principal OAuth M2M client ID (preferred) | `a1b2c3d4-e5f6-...` |
| `DATABRICKS_CLIENT_SECRET` | Service principal OAuth M2M client secret | `dose...` |
| `DATABRICKS_TOKEN` | Personal access token alternative; takes precedence over OAuth when set | `dapi...` |

**Service principal OAuth M2M (preferred).** Create a service principal in the Databricks account console, grant it the `User` role on the workspace, and generate a client ID/secret pair under the SP's OAuth credentials. Set `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`; leave `DATABRICKS_TOKEN` unset.

**PAT alternative.** Generate a token under User Settings → Access tokens. Set `DATABRICKS_TOKEN`; leave the `CLIENT_*` vars unset. When `DATABRICKS_TOKEN` is present the `@repo/databricks` package short-circuits OAuth and passes the token directly.

Neither credential is required in deployments that do not use any Databricks feature — all three vars are optional.

---

## 2. Lakebase as Fabric's PostgreSQL

Lakebase is real PostgreSQL 17 (Neon-based autoscaling). It supports RLS, `CREATE ROLE`, enums, `ON CONFLICT`, and standard `postgresql://` connection strings. SSL is required; the port is 5432.

### 2.1 Prerequisites

1. A Databricks workspace with a Lakebase project created (Account Console → Lakebase → Create project).
2. A Lakebase compute attached to the project (the compute provides the SQL endpoint).
3. An application database — either use the default `databricks_postgres` or create a dedicated one.
4. SSL connectivity: connection strings must include `?sslmode=require`.

### 2.2 Role provisioning

Run the following SQL against the Lakebase direct (unpooled) endpoint as the admin role.

**Native password roles (required for PgBouncer pooler and for `DIRECT_URL`):**

```sql
-- Application runtime role (used in DATABASE_URL)
CREATE ROLE fabric_app LOGIN PASSWORD '<strong-random>';
GRANT CONNECT ON DATABASE databricks_postgres TO fabric_app;
GRANT USAGE ON SCHEMA public TO fabric_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fabric_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_app;

-- (Optional) Temporal worker role — password is consumed by apply-rls-direct.ts
-- via WORKER_DB_PASSWORD at RLS deploy time
CREATE ROLE fabric_worker LOGIN PASSWORD '<worker-password>';
GRANT CONNECT ON DATABASE databricks_postgres TO fabric_worker;
GRANT USAGE ON SCHEMA public TO fabric_worker;
```

**Optional OAuth role for the service principal:**

Lakebase's `databricks_auth` extension lets you create a role tied to a Databricks identity. The role's password is a short-lived workspace token — see §2.4 for rotation details.

```sql
-- Load the extension (once per database)
CREATE EXTENSION IF NOT EXISTS databricks_auth;

-- Bind the SP to a Postgres role
SELECT databricks_create_role('<client-id-or-sp-email>', 'SERVICE_PRINCIPAL');
```

Alternatively, create OAuth roles from the Lakebase UI or the REST API. OAuth roles are created with the `databricks_auth` extension; native password roles are created with `CREATE ROLE … PASSWORD`.

### 2.3 Connection matrix

| Consumer | Endpoint | Auth | Notes |
|---|---|---|---|
| App runtime (`DATABASE_URL`) | Pooled (PgBouncer) endpoint | Native password | PgBouncer **requires** a native password role — OAuth roles cannot authenticate through the pooler |
| Migrations / RLS scripts (`DIRECT_URL`) | Direct (unpooled) endpoint | Native password (recommended) | Password role avoids token-expiry risk during long migration runs; see OAuth alternative in §2.4 |
| Temporal worker (`WORKER_DATABASE_URL` → `DATABASE_URL` at deploy) | Pooled or direct | Native password | Helm sets `DATABASE_URL` from `WORKER_DATABASE_URL` when `temporalWorker.bypassRlsRole=true`; the `fabric_worker` role is a plain password role |

Connection strings for Lakebase follow the standard format:

```
postgresql://fabric_app:<password>@<ep-xxx>.databricks.com:5432/databricks_postgres?sslmode=require
```

### 2.4 DATABASE_AUTH_PROVIDER=databricks-oauth

When `DATABASE_AUTH_PROVIDER=databricks-oauth`, the `@repo/databricks` package fetches a fresh workspace token on every new connection (passed as the PostgreSQL password). This eliminates the need to rotate a static password but has constraints:

- **Pooler incompatible.** The PgBouncer pooler requires a stable password. Set `DATABASE_URL` to the **direct** endpoint when using OAuth, or keep `DATABASE_URL` on a native password role + pooler and reserve OAuth for a secondary connection.
- **Token lifetime.** Databricks workspace tokens expire after 1 hour. Expiry is enforced at login only — open connections survive until the pool recycles them. Fabric's pg pool sets `maxLifetimeSeconds` to 6 hours automatically in this mode (`packages/database/prisma/adapter-config.ts`).
- **DATABASE_URL password field.** Omit the password from the connection string; the auth package injects it dynamically: `postgresql://fabric_oauth_role@<host>:5432/<db>?sslmode=require`.
- **Migrations recommendation.** Keep a native password role for `DIRECT_URL` — long migration runs must not depend on a 1-hour token. As a CI alternative, mint a short-lived token at pipeline start:

  ```bash
  # CI: mint a 1h token and inject it into DIRECT_URL
  TOKEN=$(databricks auth token --host "$DATABRICKS_HOST" | jq -r .access_token)
  export DIRECT_URL="postgresql://fabric_oauth_role:${TOKEN}@<host>:5432/<db>?sslmode=require"
  ```

### 2.5 WORKER_RLS_MODE

Fabric's `apply-rls-direct.ts` script grants the `fabric_worker` role `BYPASSRLS` to let the Temporal worker read across all tenant rows without per-row overhead. On some Lakebase deployments the admin role is not a PostgreSQL superuser and cannot grant `BYPASSRLS` — you'll see:

```
ERROR: must be superuser to change BYPASSRLS attribute
```

Set `WORKER_RLS_MODE=policy` as the fallback. Instead of `BYPASSRLS`, the script creates permissive per-table `worker_bypass` policies scoped `TO fabric_worker`:

```sql
CREATE POLICY worker_bypass ON <table> FOR ALL TO fabric_worker USING (true) WITH CHECK (true);
```

The default (`WORKER_RLS_MODE=bypassrls`) attempts the `BYPASSRLS` grant. Run `pnpm --filter @repo/database test:lakebase` (§2.7) to probe which mode your Lakebase instance supports before running the RLS deploy.

**Pre-provisioned worker role (`WORKER_ROLE_PREPROVISIONED`).** Policy mode still needs the `fabric_worker` role to exist, and on managed Postgres (Lakebase) the deploy/app role usually cannot `CREATE`/`ALTER` roles — nor is anyone a superuser, which even applying the (default) `NOBYPASSRLS` attribute requires. So the RLS deploy cannot self-provision the role there. Instead, create it once as an admin (§2.2), then set `WORKER_ROLE_PREPROVISIONED=true`: `apply-rls-direct.ts` skips all role/grant management and only attaches the per-table `worker_bypass` policies — which the table-owning role *can* do. Leave it unset on Neon/AWS, where the deploy connection manages the role and its grants itself (driven by `WORKER_DB_PASSWORD`).

**App role bypass (`APP_RLS_BYPASS`).** On Neon, the application role (`fabric_app`) implicitly bypassed RLS via `neon_superuser` membership, so the app's normal query path — the raw `db` client with explicit tenant `WHERE` filters, which is the documented isolation boundary in `packages/database/prisma/queries/projects/publishing-suite.ts` — never had to contend with row filtering. Lakebase grants no such membership: under enforced `FORCE ROW LEVEL SECURITY` with no per-request tenant context set, every raw-db query returns zero rows (symptom: org data missing entirely from the UI, not merely filtered). Set `APP_RLS_BYPASS=true` on Lakebase deployments: `apply-rls-direct.ts` then attaches an explicit permissive per-table policy to `fabric_app`, mirroring `worker_bypass`:

```sql
CREATE POLICY app_bypass ON <table> FOR ALL TO fabric_app USING (true) WITH CHECK (true);
```

This requires the `fabric_app` role to already exist (it owns the tables on Lakebase). It is wired the same way as `WORKER_ROLE_PREPROVISIONED`: on Azure set the `APP_RLS_BYPASS` GitHub Actions **variable** to `true` (read by the `deploy-azure-container-apps.yml` RLS deploy step); on Helm set `databricks.appRlsBypass: true` (forwarded to the migration hook in `deploy/helm/fabric/templates/jobs/migrate.yaml`). Both default to `false`. Leave it unset/`false` on Neon/AWS. Removing it later (moving the app's raw-db query layer onto `getTenantDb`-style per-request tenant context instead of relying on this blanket policy) is a prerequisite before disabling it on Lakebase — until then, disabling it there reproduces the zero-rows failure.

### 2.6 Connection-lifetime caveats

| Limit | Value | Implication |
|---|---|---|
| OAuth token lifetime | 1 hour | Expiry enforced at login; open connections survive. Pool `maxLifetime` ≤ 6h recommended. |
| Idle timeout | 24 hours | Connections idle longer than 24h are dropped server-side. The pg pool `idleTimeoutMillis` should be < 24h. |
| Max connection life | 3 days | Lakebase closes connections older than 3 days. Set pool `maxLifetime` ≤ 72h. |

The default pg pool settings in `packages/database` respect these limits. Review them if you tune pool size for a high-traffic Lakebase deployment.

### 2.7 Validation

**Quick probe:**

```bash
DATABRICKS_LAKEBASE_TEST_URL="postgresql://fabric_app:<pw>@<ep-xxx>.databricks.com:5432/databricks_postgres?sslmode=require" \
  pnpm --filter @repo/database test:lakebase
```

The probe checks (non-destructive — every probe runs in a rolled-back transaction or cleans up after itself):
- Connectivity, SSL, and server version
- `set_config` round-trip (the mechanism RLS tenant context relies on)
- ENUM type creation and `ON CONFLICT` upserts
- Whether `CREATE ROLE ... BYPASSRLS` is permitted (determines `WORKER_RLS_MODE`)
- `CREATE POLICY` capability

**Full spike checklist (scratch Lakebase branch):**

```bash
# 1. Apply migrations against Lakebase (direct endpoint)
cd packages/database
DATABASE_URL="<direct-endpoint-url>" DIRECT_URL="<direct-endpoint-url>" \
  npx prisma migrate deploy --schema=./prisma/schema.prisma

# 2. Apply RLS policies (connects via DATABASE_URL)
DATABASE_URL="<direct-endpoint-url>" WORKER_RLS_MODE="<bypassrls|policy>" \
  WORKER_DB_PASSWORD="<worker-password>" \
  pnpm --filter @repo/database deploy:rls

# 3. Verify RLS isolation (vitest suite, connects via DATABASE_URL)
DATABASE_URL="<direct-endpoint-url>" pnpm --filter @repo/database test:rls

# 4. App smoke test
DATABASE_URL="<pooled-endpoint>" DATABASE_AUTH_PROVIDER="<password|databricks-oauth>" \
  pnpm --filter web dev
```

---

## 3. Temporal persistence

The self-hosted Temporal server can point its persistence database at a Lakebase endpoint — Temporal supports PostgreSQL 12+ and Lakebase is PostgreSQL 17. However, **Fabric recommends Temporal Cloud or a dedicated Postgres instance** for Temporal persistence:

- Lakebase's 24h idle timeout conflicts with Temporal's long-held connection pool.
- The 1-hour OAuth token expiry (if used) creates reconnect churn in Temporal's internal persistence layer, which is not designed for rotating credentials.
- Separating Temporal persistence from application data simplifies RLS boundary reasoning.

Fabric does not automate or document Temporal-on-Lakebase configuration. If you pursue it, use a native password role and the direct (unpooled) endpoint.

---

## 4. Secrets in cloud deploys

`DATABRICKS_CLIENT_SECRET` and `DATABRICKS_TOKEN` are secrets; `DATABRICKS_HOST`, `DATABASE_AUTH_PROVIDER`, `WORKER_RLS_MODE`, and `WORKER_ROLE_PREPROVISIONED` are plain configuration (ConfigMap).

For Lakebase in **policy** mode you must also enable the worker role in the RLS deploy step, or `worker_bypass` policies are silently skipped: on Azure set the `WORKER_ROLE_PREPROVISIONED` GitHub Actions **variable** to `true`; on Helm set `databricks.workerRolePreprovisioned: true`. Both default to `false`. This requires the `fabric_worker` role to already exist (admin-provisioned per §2.2), since managed Postgres blocks the deploy connection from running `CREATE ROLE`.

In AWS/Kubernetes deployments, the secret values live in the `fabric/<env>/databricks` Secrets Manager group (§3.14 in `ENVIRONMENT-VARIABLES.md`). The ExternalSecret CRD projects them automatically — no chart change required.

In Azure Container Apps deployments, the `deploy-azure-container-apps.yml` workflow syncs the `DATABRICKS_*` GitHub Secrets into Key Vault and wires them (plus `DATABASE_AUTH_PROVIDER` / `WORKER_RLS_MODE`) into every container app that opens a Prisma connection — the temporal worker and `weave-planners`. The two mode values come from the Bicep parameters `databaseAuthProvider` and `workerRlsMode`, which the deploy workflow reads from the GitHub Actions **variables** `DATABASE_AUTH_PROVIDER` and `WORKER_RLS_MODE` (defaults: `password` / `bypassrls`) — set those repository/environment variables to enable Lakebase OAuth mode or the policy RLS fallback on Azure.

A separate, optional GitHub secret, `WORKER_DATABASE_URL`, carries the `fabric_worker` connection string itself (the direct endpoint is recommended). The deploy workflows sync it to Key Vault as `worker-database-url`, which the temporal worker and `weave-planners` containers read as their `DATABASE_URL` — distinct from the `database-url` secret the rest of the app uses. When unset it falls back to `DATABASE_URL`, so environments where the worker shares the app's role (Neon) are unaffected. On Lakebase in policy mode this secret is required: the `worker_bypass` policies from §2.5 are scoped `TO fabric_worker`, so a worker connecting as `fabric_app` would be blocked by `FORCE ROW LEVEL SECURITY`.

See `ENVIRONMENT-VARIABLES.md` §3.14 for the full JSON contract and `AWS-DEPLOYMENT.md` for the Secrets Manager `put-secret-value` workflow.

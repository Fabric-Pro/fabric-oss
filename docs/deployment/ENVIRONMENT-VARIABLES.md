# Fabric — Environment Variable Reference

The complete contract between the deployment and the application.

## 1. Where env vars come from

Pods running in the `fabric` namespace receive env vars from three sources, merged in this order (later sources win when names collide):

1. **ConfigMap `<release>-config`** — rendered by Helm from `.Values` at install time. Non-secret runtime config: cluster DNS URLs, S3 bucket names, Temporal address, Redis URL (ElastiCache), public OTEL settings.
2. **Secret `fabric-app-secrets`** — synced from AWS Secrets Manager by External Secrets Operator. Every key in every JSON-formatted secret group is projected as an env var of the same name.
3. **Pod-level `env:` blocks** in the chart templates — runtime-injected (`NODE_IP` from `fieldRef`, `OTEL_EXPORTER_OTLP_ENDPOINT` derived from `NODE_IP`).

> **Critical contract.** The JSON keys in each Secrets Manager group must **exactly match** the env var names the application expects. The ExternalSecret uses `dataFrom: extract:` (`deploy/helm/fabric/templates/secrets/external-secrets.yaml`), which projects every key as-is — no remapping. A typo silently becomes a different env var that the app never reads.

### Source precedence in practice

`REDIS_URL` is the single load-bearing example. It belongs in **one place only**: the `fabric/<env>/redis` Secrets Manager group, auto-populated by Terraform with the TLS scheme (`rediss://`) and the generated ElastiCache AUTH token. The ConfigMap intentionally does NOT render a fallback — a non-TLS / no-auth `redis://<endpoint>:6379` would shadow the secret if the secret JSON were ever wiped (e.g. by `put-secret-value` without read-merge-write), leaving the app talking plaintext to a TLS+AUTH-only cluster.

Upstash REST credentials live in their own group, `fabric/<env>/upstash` (so operator `put-secret-value` on Upstash keys can never clobber the Terraform-managed `REDIS_URL`).

The "ConfigMap for plumbing, Secret for credentials" rule still applies to everything else: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, all the `*_URL` agent endpoints, and the public `NEXT_PUBLIC_*` keys live in ConfigMap.

---

## 2. By service

Each service consumes a subset of the merged env vars. The chart's `_envFrom.tpl` partial wires both `configMapRef.name: <release>-config` and `secretRef.name: fabric-app-secrets` for every Deployment, so the application code only needs to read `process.env.<NAME>` — the platform layer projects all of the below into every pod that needs them.

The table below lists the **functional consumer** for each variable: where the value is actually read in the codebase. A variable that has `(all)` as its consumer is forwarded to every pod (because filtering at the chart level adds maintenance burden without saving real memory).

### 2.1 `web` (Next.js)

| Env var | Source | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | ConfigMap | yes | Fixed at `"production"` |
| `NEXT_PUBLIC_SITE_URL` | ConfigMap | yes (HTTPS) | Rendered from `global.siteUrl` if set (explicit override, precedence over domain; ingress stays host-less), else `https://<global.domain>` when domain set, else empty. |
| `DATABASE_URL` | Secret | yes | Auto-populated by Terraform (`aws_secretsmanager_secret_version.database`) |
| `DIRECT_URL` | Secret | yes | Same as DATABASE_URL for non-PgBouncer setups |
| `BETTER_AUTH_SECRET` | Secret | yes | `openssl rand -base64 48` |
| `BRUTE_FORCE_IP_LOCKOUT_CAP` | ConfigMap | no | Default `3` |
| `REDIS_URL` | Secret (`redis` group) | yes | `rediss://default:<token>@<endpoint>:6379` — Terraform-managed |
| `UPSTASH_REDIS_REST_URL` | Secret (`upstash` group) | yes | Rate-limit + MCP route |
| `UPSTASH_REDIS_REST_TOKEN` | Secret (`upstash` group) | yes | |
| `S3_ENDPOINT` | ConfigMap | yes | `https://s3.<region>.amazonaws.com` |
| `S3_REGION` | ConfigMap | yes | |
| `S3_ACCESS_KEY_ID` | Secret (optional) | no | Omit on EKS — the S3 client falls back to the AWS SDK default credential chain (IRSA) when both keys are unset. Set only for MinIO / R2 / static IAM users. |
| `S3_SECRET_ACCESS_KEY` | Secret (optional) | no | Pair with `S3_ACCESS_KEY_ID`; both or neither. |
| `STORAGE_PROVIDER` | ConfigMap | no | Defaults to `s3` in prod |
| `NEXT_PUBLIC_AVATARS_BUCKET_NAME` | ConfigMap | yes | |
| `NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME` | ConfigMap | yes | |
| `NEXT_PUBLIC_PROJECT_CONTEXTS_BUCKET_NAME` | ConfigMap | yes | |
| `TEMPORAL_ADDRESS` | ConfigMap | yes | |
| `TEMPORAL_NAMESPACE` | ConfigMap | yes | |
| `TEMPORAL_CLOUD_API_KEY` | Secret | yes | |
| `ENABLE_TEMPORAL_WORKFLOWS` | ConfigMap | yes | `"true"` |
| `MCP_STDIO_WRAPPER_URL` | ConfigMap | yes | Cluster DNS |
| `DOCUMENT_GENERATOR_URL` | ConfigMap | yes | Rendered from `agents[]` |
| `PROJECT_DOCUMENT_GENERATOR_URL` | ConfigMap | yes | |
| `TASK_PLANNER_URL` | ConfigMap | yes | |
| `STORY_BREAKDOWN_URL` | ConfigMap | yes | |
| `API_AGENT_URL` | ConfigMap | yes | |
| `PROMPT_ENHANCER_URL` | ConfigMap | yes | |
| `DATA_ANALYST_URL` | ConfigMap | yes | |
| `BACKLOG_UPDATER_URL` | ConfigMap | yes | |
| `WEAVE_READERS_URL` | ConfigMap | yes | |
| `WEAVE_SHUTTLE_URL` | ConfigMap | yes | |
| `WEAVE_PLANNERS_URL` | ConfigMap | yes | |
| `BETTER_AUTH_URL` | derived | yes | Computed from `NEXT_PUBLIC_SITE_URL` if unset |
| `ANTHROPIC_API_KEY` | Secret | one-of | Any one AI provider |
| `OPENAI_API_KEY` | Secret | one-of | |
| `GROQ_API_KEY` | Secret | no | |
| `DEEPSEEK_API_KEY` | Secret | no | |
| `GOOGLE_CLIENT_ID` | Secret | one-of | At least one OAuth provider |
| `GOOGLE_CLIENT_SECRET` | Secret | one-of | |
| `FABRIC_GITHUB_CLIENT_ID` | Secret | one-of | |
| `FABRIC_GITHUB_CLIENT_SECRET` | Secret | one-of | |
| `MICROSOFT_GRAPH_CLIENT_ID` | Secret | one-of | |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | Secret | one-of | |
| `TURNSTILE_SECRET_KEY` | Secret | no | Required only when `NEXT_PUBLIC_ENABLE_CAPTCHA=true` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | ConfigMap | no | |
| `NEXT_PUBLIC_ENABLE_CAPTCHA` | ConfigMap | no | Default `"false"` |
| `NEXT_PUBLIC_PARTYKIT_HOST` | ConfigMap | yes (collab) | |
| `NEXT_PUBLIC_ENABLE_COLLABORATION` | ConfigMap | yes | |
| `COLLAB_JWT_SECRET` | Secret | yes (collab) | Signs collab tokens that PartyKit verifies |
| `SANDBOX_WORKER_URL` | ConfigMap | yes | Cloudflare worker URL |
| `SANDBOX_AUTH_SECRET` | Secret | yes | Shared with sandbox-worker |
| `AGENT_API_KEY` | Secret | yes | Inter-agent auth |
| `AI_TOKEN_SECRET` | Secret | yes | |
| `AGENT_SERVICE_SECRET` | Secret | yes | Shared with PartyKit |
| `FABRIC_API_URL` | ConfigMap | yes | Used by inter-service callers |
| `RESEND_API_KEY` | Secret | yes | Resend is the only email provider |
| `LETTA_BASE_URL` | ConfigMap | no | |
| `LETTA_API_KEY` | Secret | no | |
| `LANGSMITH_API_KEY` | Secret | no | |
| `LANGGRAPH_CLOUD_URL` | ConfigMap | no | |
| `LANGGRAPH_API_KEY` | Secret | no | |
| `STRIPE_*` | Secret | no | Stripe is the only payment provider |
| Analytics public IDs | ConfigMap | no | `NEXT_PUBLIC_POSTHOG_*` |
| `OTEL_ENABLED` | ConfigMap | no | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | pod env | no | Derived from `NODE_IP` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | ConfigMap | no | `"grpc"` |
| `FABRIC_FEATURE_*` (4 flags) | ConfigMap | no | Kill switches, default ON |
| `NEXT_PUBLIC_FABRIC_FEATURE_*` (4 mirrors) | ConfigMap | no | |
| `FABRIC_FEATURE_TEST_CASES` | ConfigMap | no | Test Cases feature (default OFF; unset = off). Set `"true"` to expose the QA tab + API. Feature-enable flag (distinct from the always-on kill switches above); mirrors `FABRIC_FEATURE_ATLAS`. |
| `NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES` | ConfigMap | no | Client mirror of `FABRIC_FEATURE_TEST_CASES` — gates the QA tab button (default OFF). |
| `FABRIC_FEATURE_TEST_PIPELINE_RESULTS` | ConfigMap | no | Automated-test pipeline-result ingestion (card 1834; default OFF; unset = off). Set `"true"` to expose the pipeline-result surface. **Implies** `FABRIC_FEATURE_TEST_CASES` — fails closed if that base flag is off. |
| `NEXT_PUBLIC_FABRIC_FEATURE_TEST_PIPELINE_RESULTS` | ConfigMap | no | Client mirror of `FABRIC_FEATURE_TEST_PIPELINE_RESULTS` — gates the pipeline-result UI (default OFF). |
| `FABRIC_FEATURE_CONTEXT_SUMMARIZATION` | ConfigMap | no | Context Summarization (default OFF; unset = off). Set `"true"` to enable the daily auto-summarization cron, the admin manual-trigger API, and summary injection into the AI context read path. Off = retrieval is byte-for-byte unchanged (rollback-safe). |
| `NEXT_PUBLIC_FABRIC_FEATURE_CONTEXT_SUMMARIZATION` | ConfigMap | no | Client mirror of `FABRIC_FEATURE_CONTEXT_SUMMARIZATION` — gates the Context-tab "Summarize context" admin control (default OFF). |
| `CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD` | ConfigMap | no | Auto-summarization trigger: raw-context token estimate above which a project is (re)summarized. Default `50000`. |
| `CONTEXT_SUMMARIZATION_STALE_DAYS` | ConfigMap | no | Auto-summarization trigger: days since the last summary (with new context) after which a project is re-summarized. Default `30`. |
| `FABRIC_FEATURE_PERSONAL_MEETINGS` | ConfigMap | no | Opt-in, default OFF. **Seed value only** — Admin → Feature Flags overrides it at runtime and takes precedence. OFF (and no override) => both personal-meeting procedures 404 and the filter control is not rendered. The `NEXT_PUBLIC_` mirror was removed in favour of the DB-backed flag. |
| `FABRIC_DEPLOYMENT_ADMIN_EMAILS` | ConfigMap | no | |
| `FABRIC_AUDIT_LOG_RETENTION_ENABLED` | ConfigMap | no | |
| `FABRIC_AUDIT_LOG_RETENTION_DAYS` | ConfigMap | no | |
| `FABRIC_PERSIST_REASONING_TRACE` | ConfigMap | no | Defaults to `false` |
| `GITHUB_WEBHOOK_SECRET` | Secret | no | Required if GitHub push webhooks used |
| `TEAMS_WEBHOOK_VERIFICATION_TOKEN` | Secret | no | Required if Teams integration enabled |
| `DATABRICKS_HOST` | ConfigMap | no | Workspace URL — required only for Databricks-backed features |
| `DATABRICKS_CLIENT_ID` | ConfigMap | no | Service principal OAuth M2M client ID |
| `DATABRICKS_CLIENT_SECRET` | Secret | no | Service principal OAuth M2M client secret |
| `DATABRICKS_TOKEN` | Secret | no | PAT alternative; takes precedence over OAuth when set |
| `DATABASE_AUTH_PROVIDER` | ConfigMap | no | Default `"password"`; set `"databricks-oauth"` for Lakebase OAuth rotation |

> **`NEXT_PUBLIC_FABRIC_FEATURE_*` mirrors are build-time only.** Next.js inlines
> them during `next build`, and `apps/web/Dockerfile` passes no build ARG for
> them, so on the Docker/Helm path setting one in the ConfigMap has no effect —
> the value is baked into the image as `undefined`. Vercel deployments are
> unaffected because Vercel supplies env at build time. Flags that need runtime
> control should be registered in
> `packages/utils/lib/feature-flag-registry.ts` and toggled from
> Admin → Feature Flags instead.

> **Admin → Feature Flags propagation is not instant.** A toggle takes up to
> ~10 seconds to take effect server-side, and each web replica picks it up
> independently (its own process-local cache), so a flip can visibly land on
> some requests before others for a few seconds. It is also not push-based to
> the browser: an already-open tab keeps the value it loaded with until the
> user navigates or reloads, because the flag rides the RSC payload of the
> `(saas)/app` layout rather than being fetched live. An admin who flips a
> flag and tells a user "try it now" should also tell them to reload.

### 2.2 `temporal-worker`

Consumes the same DB/Redis/AI/agent-URL set as `web`. Additionally:

| Env var | Source | Required | Notes |
|---|---|---|---|
| `TEMPORAL_ADDRESS` | ConfigMap | yes | |
| `TEMPORAL_NAMESPACE` | ConfigMap | yes | |
| `TEMPORAL_CLOUD_API_KEY` | Secret | yes | Worker auths to Temporal Cloud with this |
| All `*_URL` agent vars | ConfigMap | yes | Worker calls agents during activities |
| `FABRIC_API_URL` | ConfigMap | yes | Workflow callbacks |
| `AGENT_SERVICE_SECRET` | Secret | yes | |
| `PROMETHEUS_URL` | ConfigMap | no | Polled by `pollPrometheusActiveAlerts` activity |
| `FABRIC_AUDIT_LOG_RETENTION_ENABLED` | ConfigMap | no | Gates the daily retention schedule on worker boot |
| `FABRIC_AUDIT_LOG_RETENTION_DAYS` | ConfigMap | no | |
| `FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS` | ConfigMap | no | Temp-validity contract; sweep deletes temp uploads older than this + 1h margin (default 24) |
| `FABRIC_ATTACHMENT_RETENTION_DAYS` | ConfigMap | no | Deployment-wide default retention window for removed attachments, in days (default 90, accepted 1–3650). **Worker-only** — it is read by the nightly purge activity and nowhere else. A project or organization setting overrides it per tenant (tenant settings are floored at 30; the wider `1` floor here is the operator-level emergency drain). The window shown in project/organization settings comes from the shared policy constant in `@repo/utils/attachment`, **not** from this variable, so setting it on `web` changes nothing |
| `FABRIC_AUDIT_ERROR_CAPTURE_DISABLED` | ConfigMap | no | |
| `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS` | ConfigMap | no | |
| `FABRIC_FEATURE_LIVING_DOCS_REFRESH` | ConfigMap | no | Living Documents auto-refresh SWEEP kill switch — the brakes, **not** the rollout switch. Set `true` in every environment, prod included (Azure: `enableLivingDocsRefresh`, default `true`). Since Fizzy #2210 it seeds the `LIVING_DOCS_REFRESH_SWEEP` registry flag rather than being read directly, so an admin can also flip it from the console without a redeploy. Set it `false` (`az containerapp update --set-env-vars`, or pause the `document-refresh-dispatcher` schedule) to stop an in-flight refresh — the worker re-reads it immediately before it writes |
| `FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT` | ConfigMap | no | Living Documents auto-refresh ROLLOUT switch, seeding the `LIVING_DOCS_REFRESH` registry flag. Governs the masthead control **and** the four enrolment procedures together — before #2210 those were two different variables that could disagree, which is how the control came to render against an API that rejected every click. Off unless explicitly set. This is the one to turn on to launch the feature; the kill switch above stays armed independently |
| `DATABRICKS_HOST` | ConfigMap | no | Workspace URL — required only for Databricks-backed features |
| `DATABRICKS_CLIENT_ID` | ConfigMap | no | Service principal OAuth M2M client ID |
| `DATABRICKS_CLIENT_SECRET` | Secret | no | Service principal OAuth M2M client secret |
| `DATABRICKS_TOKEN` | Secret | no | PAT alternative; takes precedence over OAuth when set |
| `DATABASE_AUTH_PROVIDER` | ConfigMap | no | Default `"password"`; set `"databricks-oauth"` for Lakebase OAuth rotation |
| `WORKER_RLS_MODE` | ConfigMap | no | Default `"bypassrls"`; set `"policy"` when the host forbids the BYPASSRLS role attribute — consumed by the RLS deploy scripts |

> **No readiness probe.** `temporal-worker` has no readiness probe — a bad `TEMPORAL_CLOUD_API_KEY` / unreachable Temporal Cloud crash-loops silently and is NOT caught by `helm --wait` or smoke tests; verify worker logs after deploy.

### 2.3 `mcp-stdio-wrapper`

| Env var | Source | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | ConfigMap | yes | |
| `AGENT_API_KEY` | Secret | yes | Verifies inbound requests |
| `MCP_STDIO_WRAPPER_PORT` | implicit | no | Service exposes `3100` |
| `OTEL_*` | ConfigMap + pod env | no | |

The wrapper bridges STDIO MCP servers (e.g. Azure DevOps) to HTTP. It does not need DB/Redis/AI keys directly — the calling code does.

### 2.4 LangGraph agents (×11)

Each agent (`document-generator`, `project-document-generator`, `task-planner`, `story-breakdown`, `api-agent`, `prompt-enhancer`, `data-analyst`, `backlog-updater`, `weave-readers`, `weave-shuttle`, `weave-planners`) shares the same env-var surface:

| Env var | Source | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | ConfigMap | yes | |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. | Secret | one-of | Agent picks per task |
| `LANGSMITH_API_KEY` | Secret | no | Tracing |
| `FABRIC_API_URL` | ConfigMap | yes | Callbacks to web for tool results, RAG context |
| `AGENT_API_KEY` | Secret | yes | Outbound auth to web |
| `AGENT_SERVICE_SECRET` | Secret | yes | Inter-agent auth |
| `LETTA_*` | Secret/ConfigMap | no | Memory backend |
| Cross-agent URLs | ConfigMap | yes | e.g. `task-planner` calls `story-breakdown` via its URL |
| `OTEL_*` | ConfigMap + pod env | no | |

> The agent images are built with `tsup` and inline their workspace deps (`@repo/agent-core`, `@repo/agent-prompts`). Env-var reads happen at the entry point; new vars require an image rebuild, not just a Helm value change.

> **Dev profile.** Dev (`values-dev.yaml`) defers the 3 weave agents (`weave-readers`/`weave-shuttle`/`weave-planners`) and disables fluentbit, so the dev agent set is 8, not 11; their `*_URL` ConfigMap entries still render but point at non-existent Services.

`weave-shuttle` additionally consumes:

| Env var | Source | Required | Notes |
|---|---|---|---|
| `FABRIC_INTERNAL_URL` | ConfigMap | no | Bridge to Next.js coding-run endpoint; defaults to `FABRIC_API_URL` |

### 2.5 `migrate` Job (Helm pre-install/pre-upgrade hook)

| Env var | Source | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | Secret | yes | |
| `DIRECT_URL` | Secret | yes | |
| `NODE_ENV` | ConfigMap | yes | |

Runs `prisma migrate deploy --schema=./prisma/schema.prisma` against the live DB before the rolling update proceeds. Uses the `temporal-worker` image because that image ships the full pnpm workspace (the `web` image is a Next.js standalone build and does not contain `packages/database`).

Runs under a dedicated `fabric-migrate` SA with its own DB-only `fabric-migrate-secrets` ExternalSecret (hook weights -20/-10), because on a fresh install the app SA and `fabric-app-secrets` do not exist yet. The Job also sets `PGSSLMODE=no-verify` explicitly so node-postgres negotiates TLS to RDS (see §4).

### 2.6 `seed` Job (opt-in)

| Env var | Source | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | Secret | yes | |
| `DIRECT_URL` | Secret | yes | |
| `SEED_DEV_USERS` | rendered from `seed.devUsers` | no | |
| `SEED_USERS_JSON` | rendered from `seed.usersJson` | no | JSON array of `{email,name,role}` |
| `SEED_ORG_SLUG` | rendered from `seed.orgSlug` | no | |
| `SEED_ORG_NAME` | rendered from `seed.orgName` | no | |

Same image as `migrate` for the same reason.

### 2.7 Observability sidecars (OTEL Collector, FluentBit)

These do not consume application env vars. They read AWS credentials via IRSA and ship to CloudWatch — the only thing the application provides is the OTLP endpoint, which the pods discover via `NODE_IP` and the DaemonSet's hostPort.

---

## 3. By Secrets Manager group

The JSON contract for every key the External Secrets Operator pulls from AWS Secrets Manager. Group names match `module.secrets.var.secret_groups`. Path: `fabric/<env>/<group>`.

> **GitLab project CI/CD variables** (`DEPLOYER_ROLE_ARN` — not `AWS_ROLE_ARN`, `APP_IRSA_ROLE_ARN` — set after Phase-2 terraform, `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, `AGENT_SERVICE_SECRET`, optional `SKIP_BUILD`/`IMAGE_TAG`) are distinct from these in-cluster env vars — see `ci/gitlab/README.md`.

### 3.1 `database` (auto-populated)

```json
{
  "DATABASE_URL": "postgresql://<user>:<pass>@<host>:5432/<db>?schema=public",
  "DIRECT_URL":   "postgresql://<user>:<pass>@<host>:5432/<db>?schema=public"
}
```

Populated by `aws_secretsmanager_secret_version.database` in `environments/dev/main.tf` from the RDS module outputs. The resource has `ignore_changes = [secret_string]` so subsequent edits (via console or CLI) are not reverted on `terraform apply`. **Do not edit unless you know what you're doing** — the application uses `DIRECT_URL` for migrations and `DATABASE_URL` for runtime queries; they must point at the same database.

### 3.2 `auth`

```json
{
  "BETTER_AUTH_SECRET":   "<openssl rand -base64 48>",
  "AGENT_SERVICE_SECRET": "<openssl rand -base64 32>"
}
```

Both are self-generated random strings. `AGENT_SERVICE_SECRET` is also pasted into a GitLab CI variable (same value) so the PartyKit worker — deployed outside the cluster — can verify tokens minted by the web app.

> **Do not** put `AGENT_API_KEY`, `AI_TOKEN_SECRET`, or `COLLAB_JWT_SECRET` here — Terraform generates those in the `agents` group (§3.13), which the ExternalSecret extracts *after* `auth`, so an `auth` copy is silently overridden anyway.

### 3.3 `ai-providers`

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-XXXX",
  "OPENAI_API_KEY":    "sk-XXXX",
  "GROQ_API_KEY":      "",
  "DEEPSEEK_API_KEY":  ""
}
```

At least one of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is required. Empty strings are fine for the others; the provider resolver in `@repo/ai` skips providers without configured keys.

### 3.4 `oauth`

```json
{
  "GOOGLE_CLIENT_ID":              "<id>.apps.googleusercontent.com",
  "GOOGLE_CLIENT_SECRET":          "<secret>",
  "FABRIC_GITHUB_CLIENT_ID":       "Iv1.<id>",
  "FABRIC_GITHUB_CLIENT_SECRET":   "<secret>",
  "MICROSOFT_GRAPH_CLIENT_ID":     "<guid>",
  "MICROSOFT_GRAPH_CLIENT_SECRET": "<secret>"
}
```

At least one provider's ID/secret pair must be set. Each pair must come from the same OAuth app registration (mixing IDs and secrets across registrations produces opaque "invalid_client" errors at the provider).

### 3.5 `integrations`

```json
{
  "LANGSMITH_API_KEY":    "lsv2_pt_XXXX",
  "LETTA_API_KEY":        "XXXX",
  "LANGGRAPH_API_KEY":    "XXXX",
  "FABRIC_AI_API_KEY":    "XXXX",
  "FABRIC_SERVER_API_KEY":"XXXX"
}
```

All optional. The first three are observability/memory; the last two are for the Vercel AI Gateway path.

### 3.6 `redis` (Terraform-managed, do NOT edit)

```json
{
  "REDIS_URL": "rediss://default:<auth-token>@<endpoint>:6379"
}
```

> **Hands-off.** This JSON is written by Terraform from the ElastiCache module outputs (with `lifecycle.ignore_changes = [secret_string]` so rotations survive `terraform apply`). Do not edit it via `put-secret-value` — the call would replace the entire JSON and erase the AUTH-bearing connection string. Operator-managed Upstash credentials live in the dedicated `upstash` group (§3.6b) for exactly this reason.

### 3.6b `upstash`

```json
{
  "UPSTASH_REDIS_REST_URL":   "https://<id>.upstash.io",
  "UPSTASH_REDIS_REST_TOKEN": "AX..."
}
```

### 3.7 `temporal`

```json
{
  "TEMPORAL_CLOUD_API_KEY": "XXXX"
}
```

> Must be `TEMPORAL_CLOUD_API_KEY` — `TEMPORAL_API_KEY` is silently ignored (see `packages/temporal/src/client.ts`).

`TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` live in ConfigMap (set via the chart's `temporal.address` / `temporal.namespace`), not here. Both are supplied at deploy time rather than committed to a values file — see `deploy/helm/fabric/README.md` § Environment wiring.

### 3.8 `cloudflare`

```json
{
  "TURNSTILE_SECRET_KEY": "0xXXXX",
  "SANDBOX_AUTH_SECRET":  "<openssl rand -base64 32>"
}
```

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are GitLab CI variables (build-time only — wrangler uses them, the running pods don't), so they do not appear here.

### 3.9 `storage` (optional with IRSA)

```json
{
  "S3_ACCESS_KEY_ID":     "",
  "S3_SECRET_ACCESS_KEY": ""
}
```

Empty strings when using IRSA (recommended): the `fabric` ServiceAccount has an attached role with `s3:*` on the 7 application buckets. The AWS SDK auto-discovers IRSA credentials when no explicit keys are set.

Set explicit keys only when integrating with a non-AWS S3-compatible store (MinIO, Cloudflare R2 over S3 API, etc.).

### 3.10 `email`

Resend is the only supported email provider.

```json
// Resend
{ "RESEND_API_KEY": "re_XXXX" }
```

### 3.11 `payments` (optional)

Stripe is the only supported payment provider (or skip entirely).

```json
// Stripe
{
  "STRIPE_SECRET_KEY":               "sk_XXXX",
  "STRIPE_WEBHOOK_SECRET":           "whsec_XXXX",
  "STRIPE_AI_GATEWAY_RESTRICTED_KEY":"rk_XXXX"
}
```

### 3.12 `qdrant` (Terraform-managed, do NOT edit)

```json
{
  "QDRANT_API_KEY": "<random, generated by Terraform>"
}
```

> **Hands-off.** Written by `aws_secretsmanager_secret_version.qdrant` in `environments/dev/main.tf` from `random_password.qdrant_api_key` (with `lifecycle.ignore_changes = [secret_string]`). The same value is consumed by the in-cluster Qdrant StatefulSet and by `@repo/ai`. Do not edit via `put-secret-value`.

### 3.13 `agents` (Terraform-managed, do NOT edit)

```json
{
  "AGENT_API_KEY":     "<random, generated by Terraform>",
  "AI_TOKEN_SECRET":   "<random, generated by Terraform>",
  "COLLAB_JWT_SECRET": "<random, generated by Terraform>"
}
```

> **Hands-off.** Written by `aws_secretsmanager_secret_version.agents` in `environments/dev/main.tf` from three `random_password` resources (with `lifecycle.ignore_changes = [secret_string]`). The ExternalSecret extracts `agents` *after* `auth`, so these intentionally live here, not in `auth` (§3.2). Do not edit via `put-secret-value`.

### 3.14 `databricks` (optional)

```json
{
  "DATABRICKS_CLIENT_ID":     "<service-principal-client-id>",
  "DATABRICKS_CLIENT_SECRET": "<service-principal-client-secret>",
  "DATABRICKS_TOKEN":         "<personal-access-token>"
}
```

All three keys are optional — only populate the ones your deployment uses. `DATABRICKS_CLIENT_ID` + `DATABRICKS_CLIENT_SECRET` are the recommended SP OAuth M2M pair; `DATABRICKS_TOKEN` is the PAT alternative and takes precedence over OAuth when present.

> `DATABRICKS_HOST`, `DATABASE_AUTH_PROVIDER`, and `WORKER_RLS_MODE` are **not** secrets — they are plain configuration values and belong in ConfigMap (§2.1–2.2), not in this group.

See `docs/deployment/DATABRICKS.md` for the full Lakebase setup guide including role provisioning, connection matrix, OAuth rotation, and the `test:lakebase` validation suite.

---

## 4. ConfigMap-only env vars

Rendered into `<release>-config` by `templates/secrets/config-map.yaml`. Pure non-secret runtime configuration.

| Var | Helm value driving it | Notes |
|---|---|---|
| `NODE_ENV` | hardcoded | `"production"` |
| `NEXT_PUBLIC_SITE_URL` | `global.siteUrl` (override) → `global.domain` + `ingress.tls` | `global.siteUrl` wins when set (e.g. raw ALB hostname); else empty when domain unset (uses ALB hostname post-deploy) |
| `TEMPORAL_NAMESPACE` | `temporal.namespace` | |
| `TEMPORAL_ADDRESS` | `temporal.address` | |
| `ENABLE_TEMPORAL_WORKFLOWS` | hardcoded | `"true"` |
<!-- REDIS_URL moved out of ConfigMap — see §3.6 (Secret, Terraform-managed). -->
| `PGSSLMODE` | hardcoded | `no-verify` — forces TLS to RDS for node-postgres which defaults to no SSL; prod follow-up: verify-full + RDS CA bundle |
| `S3_ENDPOINT` | `global.region` | `https://s3.<region>.amazonaws.com` |
| `S3_REGION` | `global.region` | |
| `NEXT_PUBLIC_AVATARS_BUCKET_NAME` | `s3.buckets.avatars` | |
| `NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME` | `s3.buckets.chatDocuments` | |
| `NEXT_PUBLIC_PROJECT_CONTEXTS_BUCKET_NAME` | `s3.buckets.projectContexts` | |
| `RUNTIME_API_URL` | derived, `web.port` | `http://web.<ns>.svc.cluster.local:<port>` — agents/worker call back into the web API (AI-config, token exchange, usage logging); without it they fall back to `localhost` |
| `FABRIC_API_URL` | derived, `web.port` | Same in-cluster web URL. Read **directly** (no `RUNTIME_API_URL` fallback) by api-agent + data-analyst (middleware / fabric-auth / fabric-tools). `NEXT_PUBLIC_FABRIC_API_URL` (browser login links) is deliberately not set — data-analyst's UI isn't Ingress-exposed here |
| `MCP_STDIO_WRAPPER_URL` | derived | `http://mcp-stdio-wrapper.<ns>.svc.cluster.local:3100` |
| `<AGENT>_URL` (×11) | `agents[].name`, `agents[].port` | Cluster DNS, one per agent |
| `NEXT_PUBLIC_ENABLE_COLLABORATION` | `collaboration.enabled` | |
| `NEXT_PUBLIC_PARTYKIT_HOST` | `collaboration.partykitHost` | |
| `OTEL_ENABLED` | `otelCollector.enabled` | |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | hardcoded | `"grpc"` |

> **Extension point.** When you add a new non-secret env var, the right place is `templates/secrets/config-map.yaml`, not `templates/_envFrom.tpl`. Adding it to the ConfigMap means every Deployment picks it up automatically through the `envFrom: configMapRef` block.

---

## 5. Pod-level env (per-template `env:` blocks)

These are not in ConfigMap or Secret — they're set in the Deployment spec itself.

| Var | Source | Defined in |
|---|---|---|
| `NODE_IP` | `valueFrom.fieldRef: status.hostIP` | `_deployment.tpl` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | computed from `NODE_IP` | `_deployment.tpl` (only when `otelCollector.enabled`) |

Used because the OTEL Collector is a DaemonSet listening on the node IP. The application pod doesn't know its node's IP statically, so it reads it at startup from the downward API.

---

## 6. Adding a new env var

A short checklist when introducing a new variable:

1. **Decide if it's a secret.** If yes → goes into the appropriate Secrets Manager group (`fabric/<env>/<group>`). If no → goes into the ConfigMap.
2. **For secrets:** add the JSON key to your `aws secretsmanager put-secret-value` payload. The ExternalSecret's `dataFrom: extract:` already projects whatever's in the JSON, so no chart change is required.
3. **For non-secrets:** add the key to `templates/secrets/config-map.yaml` (and a value in `values.yaml` if it should have a default). The chart's `envFrom: configMapRef` block already exists in `_envFrom.tpl`, so the new key automatically appears as an env var on every pod.
4. **Document the new variable here.** Add a row to the appropriate service table in §2 and to the secret group's JSON contract in §3.
5. **If only one service needs the variable** and you want to scope it tightly, add an explicit `env:` block in that service's template instead of using the shared `envFrom`. The MVP chart doesn't bother — the cost of forwarding all vars to all pods is negligible and the chart stays simpler.

---

## 7. Verification

After a deploy, confirm the env-var contract end-to-end:

```bash
# 1. ExternalSecret is reconciled — should show Ready=True
kubectl get externalsecret fabric-app-secrets -n fabric

# 2. The rendered Secret exists and has all expected keys
kubectl get secret fabric-app-secrets -n fabric -o json \
  | jq '.data | keys'

# 3. The ConfigMap has all expected keys
kubectl get configmap fabric-config -n fabric -o json \
  | jq '.data | keys'

# 4. A web pod sees the merged result
kubectl exec -n fabric deploy/web -- env | sort | head -50
```

If `kubectl get externalsecret` shows `Ready=False`, see [TROUBLESHOOTING.md § External Secrets Operator](./TROUBLESHOOTING.md#5-external-secrets-operator).

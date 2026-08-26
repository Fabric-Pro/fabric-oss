# `party-cf/` — Collaboration Workers (Cloudflare)

Cloudflare Workers + Durable Objects deployment of the realtime collaboration servers. Mirrors `party/` (the PartyKit source) but uses [`partyserver`](https://www.npmjs.com/package/partyserver) and [`y-partyserver`](https://www.npmjs.com/package/y-partyserver) so it runs on stock Cloudflare Workers.

> **Production and staging both run from this folder.** Local dev uses `party/` via Aspire.

## Deployed

| Environment | Worker | Deploy trigger | GitHub env (secrets scope) |
|-------------|--------|-----------------|------------------------------|
| Production | `fabric-collab-prod` | `v*.*.*` tag push → `deploy-partykit-prod.yml` | Production |
| Staging | `fabric-collab-staging` | master merges touching `party-cf/**` (or manual dispatch) → `deploy-partykit-staging.yml` | dev |

- **URL:** `https://<worker-name>.<account-subdomain>.workers.dev` (set per Cloudflare account)
- **Cloudflare account ID:** set `CLOUDFLARE_ACCOUNT_ID` in CI / wrangler env
- **Health check:** `GET /health` → `{"status":"healthy", ...}`

## Architecture

| Binding | Class | URL | Purpose |
|---------|-------|-----|---------|
| `Main` | `Document` | `/parties/main/<documentId>` | Y.js CRDT sync (`YServer` from y-partyserver). State persisted to Durable Object SQLite via `onLoad`/`onSave`. |
| `Orchestrator` | `Orchestrator` | `/parties/orchestrator/<executionId>` | Broadcasts orchestrator status to subscribed clients. |
| `TaskAgent` | `TaskAgent` | `/parties/task-agent/<planId>` *and* `/parties/taskagent/<planId>` (legacy) | Broadcasts task-agent status. The Worker entry rewrites the no-hyphen path so the temporal publisher (which uses `taskagent`) keeps working. |
| `Health` | `Health` | `/parties/health/<id>` | Aspire-style health check (also available at root `/health`). |

All four `class_name`s are declared as `new_sqlite_classes` in `wrangler.toml` (modern DO storage backend; cannot be switched later). Staging redeclares its own `[[env.staging.durable_objects.bindings]]` set — Durable Object namespaces are per-Worker, so staging and production never share storage.

## Files

```
party-cf/
├── wrangler.toml          # account_id, bindings, migrations, vars, [env.staging]
├── package.json           # depends on partyserver, y-partyserver, yjs, wrangler
├── tsconfig.json
└── src/
    ├── index.ts           # Worker fetch handler + routePartykitRequest
    ├── env.ts             # Env interface (typed bindings + secrets)
    ├── document.ts        # Y.js doc DO (extends YServer)
    ├── orchestrator.ts    # extends Server, hibernation enabled
    ├── taskAgent.ts       # extends Server, hibernation enabled
    └── health.ts          # extends Server
```

## Secrets (Worker-side)

Set as Cloudflare Worker secrets, **not** in `wrangler.toml`. Each Worker (prod, staging) holds its own copy:

| Worker secret | Source of truth | Notes |
|---------------|----------------|-------|
| `FABRIC_API_URL` | GitHub `Production`/`dev` environment secret (mirrored to Azure KV `fabric-api-url` by `deploy-azure-container-apps.yml`) | The public URL of the Fabric web app (e.g. `https://fabric.example.com`) |
| `AGENT_SERVICE_SECRET` | GitHub `Production`/`dev` environment secret (mirrored to Azure KV `agent-service-secret`) | Must match the value the web app and Temporal worker send |

`PARTYKIT_ENV=production` is set as a plain var in `wrangler.toml` for both the default (prod) and `[env.staging]` sections (not secret) — staging intentionally runs in "production" auth mode. That rehearses the real token → verify → subscribe flow end-to-end for **document collab** and — since issue #624 shipped their scoped JWTs — for **orchestrator/task-agent** as well (their publish/replay paths are exercised regardless, via `AGENT_SERVICE_SECRET`).

## Local commands

```bash
# from repo root, after pnpm install
pnpm --filter fabric-collab-prod type-check
pnpm --filter fabric-collab-prod dev          # wrangler dev (needs FABRIC_API_URL + AGENT_SERVICE_SECRET in .dev.vars)
pnpm --filter fabric-collab-prod deploy       # manual deploy (prod, default env)
pnpm --filter fabric-collab-prod tail         # stream prod logs
```

## Manual deploy

Production:

```bash
cd party-cf
npx wrangler deploy --env=""
```

Staging:

```bash
cd party-cf
npx wrangler deploy --env staging
```

After a manual deploy, push secrets if they changed:

```bash
# Production
az keyvault secret show --vault-name <your-prod-kv> --name fabric-api-url --query value -o tsv \
  | npx wrangler secret put FABRIC_API_URL --env=""

az keyvault secret show --vault-name <your-prod-kv> --name agent-service-secret --query value -o tsv \
  | npx wrangler secret put AGENT_SERVICE_SECRET --env=""

# Staging
az keyvault secret show --vault-name <your-staging-kv> --name fabric-api-url --query value -o tsv \
  | npx wrangler secret put FABRIC_API_URL --env staging

az keyvault secret show --vault-name <your-staging-kv> --name agent-service-secret --query value -o tsv \
  | npx wrangler secret put AGENT_SERVICE_SECRET --env staging
```

## CI deploy

Production deploys on **`v*.*.*` tag push** (matching the changesets-driven release flow — see `docs/deployment.md`), via `.github/workflows/deploy-partykit-prod.yml`. Staging deploys on **master merges touching `party-cf/**`** (or manual dispatch), via `.github/workflows/deploy-partykit-staging.yml`.

Both workflows read secrets by the same names — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FABRIC_API_URL`, `AGENT_SERVICE_SECRET`, `PARTYKIT_HEALTHCHECK_URL` — from a different GitHub **environment** scope: prod reads from the `Production` environment, staging reads from `dev`. Each environment carries its own values (Production scope = prod values, dev scope = staging values); there is no `_PROD`/`_STAGING` suffix on the secret names themselves. One-time setup per environment at Settings → Environments:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Workers Scripts:Edit` permission
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID
- `FABRIC_API_URL` — mirror of KV `fabric-api-url` for that tier
- `AGENT_SERVICE_SECRET` — mirror of KV `agent-service-secret` for that tier
- `PARTYKIT_HEALTHCHECK_URL` — full URL the post-deploy smoke test curls (e.g. `https://<worker-name>.<account-subdomain>.workers.dev/health`)

The prod workflow deploys first, then re-pushes secrets with `wrangler secret put` — note every `wrangler secret put` creates and deploys a new Worker version, it is **not** a no-op when the value is unchanged. The staging workflow avoids that churn (and the window where a freshly-deployed Worker is live without its secrets) by shipping code and secrets atomically with `wrangler deploy --secrets-file`.

## Rollback

Cloudflare keeps deployment history per environment. To roll back:

```bash
# Production
cd party-cf
npx wrangler deployments list --env=""
npx wrangler rollback <version-id> --env=""

# Staging
cd party-cf
npx wrangler deployments list --env staging
npx wrangler rollback <version-id> --env staging
```

If the Worker is fully broken end-to-end, the web app times out after 12s (`DocumentEditor.tsx:300`) and falls through to non-collaborative mode — users keep editing, they just lose presence and live sync until the Worker is fixed.

## Cutting prod over (one-time, after first deploy)

The web app reads `NEXT_PUBLIC_PARTYKIT_HOST` at build time. Until that's updated and the web is rebuilt, the Worker is deployed but not actually being used.

1. Update Azure KV: `az keyvault secret set --vault-name <your-prod-kv> --name partykit-host --value '<worker-name>.<account-subdomain>.workers.dev'`
2. Trigger a prod web rebuild (Azure Container Apps deploy / Vercel redeploy / whatever your prod web pipeline is).
3. Verify in browser: open a project document in prod, open DevTools console, expect:
   - `[useCollaborativeEditor] Status event: connected`
   - `[useCollaborativeEditor] Sync event: true`
   - No `wss://test/...` 1006 errors, no 12s "Connecting to collaboration server" timeout.

## Staging cutover runbook (issue #2276)

1. GitHub `dev` environment: add secret `PARTYKIT_HEALTHCHECK_URL` = `https://fabric-collab-staging.<account-subdomain>.workers.dev/health`. Verify the Cloudflare API token has `Workers Scripts:Edit` and that no Worker named `fabric-collab-staging` already exists on the account.
2. Merge → `deploy-partykit-staging.yml` deploys the worker with secrets and smoke-tests it (health, unauthenticated publish → 401, authorized publish → 200).
3. Staging WEB cutover (Vercel): the web Vercel project's **Production** target is what serves the staging host, while production is served from a separate Vercel project. Three env vars are required there — all discovered the hard way during the 2026-07-25 cutover, because hosted-PartyKit staging ran permissive auth and never needed the last two:
   - `NEXT_PUBLIC_PARTYKIT_HOST` — the staging worker host (build-time inlined; requires a rebuild).
   - `NEXT_PUBLIC_ENABLE_COLLABORATION=true` — gates the entire collaborative editor (`DocumentEditor.tsx`); without it the collab hook never mounts, so there are no console logs, no token fetch, and no WebSocket at all.
   - `COLLAB_JWT_SECRET` — used by `/api/collab/token` (sign) and `/api/collab/verify` (verify); missing → the token route 500s ("Server configuration error") and the editor silently stays non-collaborative. Use the tier's existing value (KV `collab-jwt-secret`) so the web app agrees with the Temporal worker and the #624 scoped-JWT surfaces.

   Redeploy, then verify in the browser: DevTools → Network → **Socket** filter (Chrome renamed WS) shows a held-open `wss://` connection to the worker, and the console logs `[useCollaborativeEditor] Status event: connected` / `Sync event: true`.
4. Temporal worker cutover (Azure): flip the GitHub dev-scope `PARTYKIT_HOST` secret to the staging worker host (bare hostname, no scheme) and dispatch `deploy-azure-container-apps.yml` so the Key Vault `partykit-host` secret syncs and the temporal-worker revision picks it up (`main.bicep` maps it to `NEXT_PUBLIC_PARTYKIT_HOST`).
5. Cutover caveats: the new worker starts with EMPTY Durable Object storage — have users save/close active collaborative documents first, and force/announce a reload after the web redeploy (already-open tabs keep the old build-time host, so the same document can otherwise split-brain across two CRDT rooms that both save to the DB).
6. Verify end-to-end on staging: two-browser document collab; orchestrator + task-agent live UI (since #624 these subscribe with their own scoped JWTs, so they need the same `COLLAB_JWT_SECRET` on the web side — a missing secret 500s the token route and the live panel silently stays empty).
7. Soak, then decommission hosted PartyKit staging: keep the partykit.dev deployment as instant rollback for a soak window; afterwards delete the hosted deployment, revoke its credentials, and neuter `party/package.json`'s `deploy` script so the sunsetting platform can't be redeployed by accident.

## Notes

- **Hibernation is enabled** on the `Document`, `Orchestrator`, and `TaskAgent` DO classes via `static options = { hibernate: true }`. This lets WebSockets stay open while the DO isolate is evicted, dramatically reducing duty cycle. Y.js doc state survives because `onSave` writes to DO storage (debounced 2s, max 10s). `Health` does not set hibernation.
- **Y.js state persists per-document** in DO SQLite storage, not in the Fabric database. The DB stores the canonical markdown via the document save API path; the Y.js layer is for live multiplayer presence and conflict-free merging.
- **The temporal publisher's URL inconsistency** (`/parties/taskagent/` vs the client's `/parties/task-agent/`) is masked by a rewrite in `src/index.ts`. If you ever change either side to align them, the rewrite can go.

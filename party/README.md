# `party/` — Realtime Collaboration Servers (local dev)

> **In transition.** This folder still hosts staging on `*.partykit.dev` today, but staging is cutting over to the Cloudflare Worker in `../party-cf/`. See the cutover runbook in [`../party-cf/README.md`](../party-cf/README.md#staging-cutover-runbook-issue-2276) (issue #2276). Once that completes, this folder is local-dev only.

This package hosts the PartyKit-style servers that power realtime features in Fabric:

| Party | File | Purpose |
|-------|------|---------|
| `document` | `document.ts` | Y.js CRDT sync for the collaborative document editor. Auth via `/api/collab/verify` on the web app. |
| `orchestrator` | `orchestrator.ts` | Live status broadcast for the Temporal orchestrator (agent runs). Auth via `AGENT_SERVICE_SECRET`. |
| `taskagent` | `taskAgent.ts` | Live status broadcast for individual task agents. Auth via `AGENT_SERVICE_SECRET`. |
| `health` | `health.ts` | Health check endpoint for Aspire. |

Local dev runs through Aspire (`./aspire.sh restart`), which calls `start-dev.sh` to spawn `partykit dev` on the port Aspire assigned.

## Deployment Targets

Production runs on **Cloudflare Workers** from a separate package — see [`../party-cf/README.md`](../party-cf/README.md). The two folders share the same auth contracts and message shapes; production was forked because the PartyKit-hosted runtime and stock Cloudflare Workers have different APIs.

| Environment | Source | Platform | URL |
|-------------|--------|----------|-----|
| Local dev   | `party/` (this folder) | `partykit dev` via Aspire | `localhost:1999` |
| Staging — current, until cutover | `party/` (this folder) | PartyKit (hosted, sunsetting) | `*.partykit.dev` |
| Staging — target (#2276) | `party-cf/` | Cloudflare Workers | `fabric-collab-staging.<account-subdomain>.workers.dev` |
| Production  | `party-cf/` | Cloudflare Workers | `<worker-subdomain>.workers.dev` |

Staging is mid-migration: the hosted-PartyKit deployment is what staging runs **today**; the Cloudflare Worker becomes authoritative once the cutover runbook in `../party-cf/README.md` completes (tracked in #2276). When debugging staging realtime, check which host the web app's `NEXT_PUBLIC_PARTYKIT_HOST` build actually points at.

When you change shared logic (auth shapes, message types), **update both folders**. There is no shared source today; the two are kept structurally similar so a diff highlights drift.

## Server-side env vars

| Var | Purpose |
|-----|---------|
| `PARTYKIT_ENV` | Set to `production` to enforce real auth. Anything else allows dev fallback (no token verification). |
| `FABRIC_API_URL` | Origin of the Fabric web app. Used to call `/api/collab/verify`, `/api/orchestrator/verify`, `/api/task-agent/verify`. |
| `AGENT_SERVICE_SECRET` | Shared secret with the web app for orchestrator/taskagent broadcast POSTs. |

For staging set these via `partykit env add`. For production see [`../party-cf/README.md`](../party-cf/README.md).

## Client-side env

`NEXT_PUBLIC_PARTYKIT_HOST` is built into the web app at build time (it's a `NEXT_PUBLIC_*` var — Next.js inlines it at build, not runtime). Changing it requires a web rebuild + redeploy.

| Environment | Value |
|-------------|-------|
| Local dev | `localhost:1999` |
| Staging | `fabric-collab-staging.<account-subdomain>.workers.dev` |
| Production | `<worker-subdomain>.workers.dev` |

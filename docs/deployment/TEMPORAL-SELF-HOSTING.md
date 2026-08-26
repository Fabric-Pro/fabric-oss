# Fabric — Self-Hosted Temporal Requirements

Everything a self-hosting customer needs to run Fabric's workflow engine on their **own** Temporal cluster, instead of Temporal Cloud — the Fabric-specific contract that Temporal's own documentation cannot describe.

> **Audience.** A platform engineer standing up Fabric in their own cloud (e.g. on AWS) who must operate a self-hosted Temporal cluster. Assumes familiarity with Temporal concepts (namespaces, task queues, workers) but **not** with Fabric's internals.
>
> **Status.** Every load-bearing claim is cited to a source `file:line` on `master` so it can be re-verified rather than trusted. Where something is **not yet validated on a real self-hosted server**, this document says so explicitly rather than guessing — see [§9 Payload limits](#9-payload-and-message-size-limits-read-this-before-quoting-a-number) and [§14 Open items](#14-open-items--not-yet-validated).
>
> **Scope.** Fabric's requirements *of* a Temporal cluster. It does **not** re-document how to install Temporal itself (see [Temporal's self-hosted guide](https://docs.temporal.io/self-hosted-guide)); it documents the namespaces, task queues, schedules, payload settings, connection modes, and external dependencies that Fabric's code assumes. Pairs with [`AWS-DEPLOYMENT.md`](./AWS-DEPLOYMENT.md), [`EXTERNAL-SERVICES.md`](./EXTERNAL-SERVICES.md), and [`ENVIRONMENT-VARIABLES.md`](./ENVIRONMENT-VARIABLES.md).

---

## Contents

1. [The short version](#1-the-short-version)
2. [What Fabric uses Temporal for](#2-what-fabric-uses-temporal-for)
3. [Server version and image](#3-server-version-and-image)
4. [Namespace and retention](#4-namespace-and-retention)
5. [Task queues (the contract)](#5-task-queues-the-contract)
6. [Scheduled workflows (crons)](#6-scheduled-workflows-crons)
7. [Search attributes](#7-search-attributes)
8. [Worker topology and sizing](#8-worker-topology-and-sizing)
9. [Payload and message-size limits](#9-payload-and-message-size-limits-read-this-before-quoting-a-number)
10. [Payload codec / encryption](#10-payload-codec--encryption)
11. [Connection and security](#11-connection-and-security)
12. [Persistence (Temporal's own database)](#12-persistence-temporals-own-database)
13. [External dependencies of the workflows](#13-external-dependencies-of-the-workflows)
14. [Open items — not yet validated](#14-open-items--not-yet-validated)
15. [Bring-up validation checklist](#15-bring-up-validation-checklist)
16. [Environment variable reference](#16-environment-variable-reference)
17. [AWS-specific caveats](#17-aws-specific-caveats)
18. [Document control (currency & sign-off)](#18-document-control-currency--sign-off)

---

## 1. The short version

- Fabric talks to Temporal through **one client factory** (`packages/temporal/src/client.ts`) and runs **one worker process hosting 12 workers** (`packages/temporal/src/worker.ts`). Reproduce the namespace, the 12 task-queue names, and the connection contract and Fabric will run against a self-hosted cluster.
- Fabric has only ever **actually run** a self-hosted Temporal server as the local `temporalio/auto-setup:1.28.0` image; **production and staging are on Temporal Cloud** (`aspire/Fabric.AppHost/Program.cs:1110-1128`). So a self-hosted *production* cluster is a **new, unproven configuration** — treat [§15](#15-bring-up-validation-checklist) as mandatory, not optional.
- **The payload story is the one that can burn a customer.** The repo ships a `blobSize` override of 16 MB, but (a) it is only applied under local Aspire, never on the docker-compose server, and never on Cloud; and (b) there is **no gRPC message-size override anywhere**, so the real transport ceiling is Temporal's default **4 MB** — which Fabric's own code is written to stay under. Do **not** tell a customer "set blobSize to 16 MB and large payloads work" until [§15](#15-bring-up-validation-checklist)'s `>4 MB` test proves it. See [§9](#9-payload-and-message-size-limits-read-this-before-quoting-a-number).
- **No custom search attributes** and **no GitLab-specific Temporal config** exist, so neither needs reproducing.
- **One genuine data-residency red flag** among the dependencies: **Firecrawl** is hard-coded to `https://api.firecrawl.dev` with no override ([§13](#13-external-dependencies-of-the-workflows)). Everything else the workflows touch is either self-hostable or optional.

---

## 2. What Fabric uses Temporal for

Fabric uses Temporal as its durable orchestration engine for every long-running or must-not-drop operation: AI document generation and RAG, the CUGA-style agent orchestrator, code indexing, security/accessibility scans, PM-tool sync, meeting-digest processing, context summarization, report generation, retention/cleanup jobs, and webhook/trigger handling. These run as **workflows** (deterministic orchestration) calling **activities** (the side-effecting work — DB writes, AI calls, HTTP). The full workflow set lives under `packages/temporal/src/workflows/**`; you do not need to enumerate it to self-host — you need to reproduce the **contract** in §§4–11.

---

## 3. Server version and image

| Property | Value | Source |
|---|---|---|
| Server image (local/dev) | `temporalio/auto-setup:1.28.0` | `docker-compose.yml:44`, `aspire/Fabric.AppHost/Program.cs:153` |
| UI image | `temporalio/ui:2.44.1` | `docker-compose.yml:66` |
| Client/worker SDK | `@temporalio/*` (see `packages/temporal/package.json`) | pinned `~1.16.3` for a workflow-isolation advisory (PR #1928) |
| gRPC endpoint | `7233` | `docker-compose.yml:56` |

**`auto-setup` vs the `server` image — a decision you must make.** The only Temporal server Fabric has run is the **`auto-setup`** image, which auto-provisions the `default` namespace and schema on boot. `auto-setup` is a convenience image intended for local development; Temporal's guidance is to run the plain `temporalio/server` image with an explicit schema-setup step for production. **This document does not assume `auto-setup` is production-appropriate — that is [Open item Q1](#14-open-items--not-yet-validated).** If you use the plain server image you must provision the namespace and schema yourself (see §4).

Version compatibility: Fabric's SDK is pinned at `~1.16.3`. Run a server version within the SDK's supported range (server `1.28.x` is what Fabric has exercised). Do not assume a newer or older server "just works" without the §15 bring-up.

---

## 4. Namespace and retention

- **Namespace:** Fabric uses a single namespace, resolved from `TEMPORAL_NAMESPACE` and **defaulting to `default`** (`packages/temporal/src/client.ts:20`). Both the client and every worker use this one namespace (`client.ts:127`, `worker.ts` per-worker `namespace: config.namespace`). A custom namespace is fine as long as the same value is set for the client (web/API tier) and the worker.
- **Namespace creation:** on `auto-setup` the `default` namespace is created for you. On the plain `server` image you must register it (`temporal operator namespace create`) **before** the worker starts, or the worker's schedule registration and workflow starts will fail.
- **Retention:** Fabric does not set a namespace retention period in code — it inherits the server/namespace default. Temporal's `auto-setup` default retention is short (≈1 day). Fabric's own audit/compliance retention is enforced in **application** code (the retention *workflows* in §6 purge Postgres rows), **not** by Temporal's history retention — so a short Temporal retention does not lose Fabric business data, it only shortens how long closed workflow *histories* are inspectable. Choose a namespace retention that fits your operational/debugging needs (7–30 days is typical); it is independent of Fabric's data-retention posture.

---

## 5. Task queues (the contract)

Fabric's worker creates **12 workers in a single process**, each polling a **hard-coded** task-queue name (`packages/temporal/src/worker.ts`). These names are the contract: clients start workflows on these exact strings, so a self-hoster cannot rename them, and the worker process must poll all 12 or the corresponding features silently stop running.

| # | Task queue | Purpose | Concurrency (activity / workflow) | Source |
|---|---|---|---|---|
| 1 | `ai-chat` | Chat title generation | 10 / 10 | `worker.ts:218` |
| 2 | `document-processing` | Document processing (RAG) | 5 / 5 | `worker.ts:232` |
| 3 | `project-documents` | AI project-document generation | 5 / 5 | `worker.ts:246` |
| 4 | `document-refresh` | Living-doc auto-refresh | 3 / 5 | `worker.ts:269` |
| 5 | `workflow-builder` | Workflow-builder executions | 10 / 10 | `worker.ts:283` |
| 6 | `fabric-worker` | General-purpose / misc workflows | 5 / 5 | `worker.ts:297` |
| 7 | `fabric-orchestrator` | CUGA-inspired agent orchestrator (long-running) | 10 / 5 | `worker.ts:318` |
| 8 | `agents` | Kanban task-agent workflows | 10 / 5 | `worker.ts:332` |
| 9 | `code-indexing` | AST-aware code indexing (tree-sitter + embeddings) | 3 / 3 | `worker.ts:346` |
| 10 | `atlas` | Repo "Atlas" analysis — **must match `ATLAS_TASK_QUEUE` in `@repo/atlas`** | 2 / 2 | `worker.ts:365` |
| 11 | `trigger-system` | Webhooks, schedules, Slack mentions | 10 / 10 | `worker.ts:377` |
| 12 | `monitoring` | **Back-compat alias of `fabric-worker`** — net-new monitoring workflows run on `fabric-worker`; this queue exists only as a deprecation bridge | 5 / 5 | `worker.ts:388-404` |

All 12 are launched together via `Promise.all([...run()])` (`worker.ts:426-438`) — **78 concurrent activity slots and 70 workflow slots** in one process (sum of the table above). If you split the worker across processes/pods for scale, ensure **every** queue is still polled by at least one worker.

> **Not a 13th queue — a known orphan.** `apps/web/app/api/frames/[id]/export/pdf/route.ts:44` enqueues to a **`frame-exports`** queue that **no worker serves**, so PDF frame-export would hang. This is a latent bug / parked feature in Fabric, **not** a queue you need to provision — flagged so you don't chase a "missing" worker.

---

## 6. Scheduled workflows (crons)

On boot, the worker calls `registerSystemSchedules()` (`worker.ts:416`), which **upserts ~22 Temporal Schedules** plus a few more registered by helper scripts (`ensure-ai-usage-schedules`, `ensure-context-summarization-schedules`, `ensure-monitoring-schedules`). The authoritative, always-current list is `packages/temporal/src/schedules.ts` — cite that file rather than any copy, because it changes.

**What a self-hoster must know:**

- Schedules are **created automatically** by the worker; you do **not** register them by hand. The requirement is that the worker's `ScheduleClient` can reach the server (same connection as the client) and that the server retains Schedules.
- Several schedules are **opt-in via environment flags** and stay inert until you set them. Most are compliance/retention jobs, deliberately off by default so an operator chooses the period; the last is a customer-notification sweep, off by default because a notification cannot be recalled:

| Schedule | Cron | Gate | Source |
|---|---|---|---|
| `audit-log-retention` | `0 3 * * *` | `FABRIC_AUDIT_LOG_RETENTION_ENABLED=true` | `schedules.ts:97-104` |
| `request-span-retention` | `45 4 * * *` | on by default; `FABRIC_REQUEST_SPAN_RETENTION_ENABLED=false` opts out | `schedules.ts:106-113` |
| `conversation-retention` | `15 5 * * *` | `FABRIC_CONVERSATION_RETENTION_ENABLED=true` **and** a positive `FABRIC_CONVERSATION_RETENTION_DAYS` | `schedules.ts:115-127` |
| `audit-log-seal` | `15 * * * *` | `FABRIC_AUDIT_LOG_SEALING_ENABLED=true` | `schedules.ts:129-135` |
| `pm-sync-log-retention` | `0 4 * * *` | `FABRIC_PM_SYNC_LOG_RETENTION_ENABLED=true` | `schedules.ts:137-145` |
| `monitoring-status-announcement-notifications` | `*/5 * * * *` | on by default; `FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED=false` stops delivery | `ensure-monitoring-schedules.ts` |

- The remaining inline schedules (project-delete cleanup, agent-health, repo-health, PM state poll, newsletter, document-refresh, scheduled reports, embedding sweep, watchdogs, attachment sweeps, etc.) run unconditionally once the worker boots. Note `project-delete-cleanup` is the only **non-UTC** schedule (`America/New_York`, `schedules.ts:24-25`) — the rest are UTC.
- **Beyond `schedules.ts`:** the three `ensure-*` helper scripts register ~7 more fixed schedules (`context-summarization-auto-scan`, five `monitoring-*` schedules, `ai-usage-gateway-cost-reconciliation`) — so the true fixed count is closer to **~29**, not 22.
- **Data-driven schedules that grow with tenant data — a sizing consideration.** Two families create **one Temporal Schedule per row**, so the Schedule count is **unbounded and tenant-scaled**, not fixed:
  - `url-source-schedule-${contextId}` — one per URL-context link in DAILY/WEEKLY/MONTHLY mode (`schedules/url-source-schedule.ts`).
  - `monitoring-synthetic-probe-${provider}` — one per registered integration provider.
  A large customer will accumulate many Schedules; size the server's visibility store accordingly. A weekly `url-source-schedule-reconcile` job GCs orphaned ones.

> **Multi-replica note.** If you run more than one worker replica, Temporal Schedules are idempotent by `scheduleId` (an upsert), so concurrent registration is safe. But the *watchdog* schedules (`weave-execution-watchdog`, `backlog-apply-watchdog`, every 5 min) assume a running worker to act on what they find.

---

## 7. Search attributes

**Fabric uses no custom search attributes.** A repo-wide check found only default/typed usage — no `upsertSearchAttributes` registration and no custom-attribute definitions in `packages/temporal/src`. **You do not need to register any custom search attributes** on the self-hosted cluster. (If this ever changes, custom attributes must be created with `temporal operator search-attribute create` before workflows that set them run.)

Likewise, **no GitLab-specific task queues or search attributes exist** — GitLab work runs on the same generic queues as everything else, so there is no GitLab-specific Temporal configuration to reproduce.

---

## 8. Worker topology and sizing

- **One process, 12 workers, shared connection** (`worker.ts:426-438`), all with `reuseV8Context: true` to share a single workflow VM across workers. Per-worker concurrency caps are in the §5 table.
- **Resource sizing reference.** On Fabric's own (Azure) infrastructure the worker container is sized at **1.75 vCPU / 3.5 GiB** (`deployment/azure/main.bicep:636-639`) after it was found to OOM-restart hourly at a 2 GiB ceiling — the 12 in-process workers (`worker.ts`) have a resident floor of ≈1.8 GiB and peak ≈2.1 GiB (sizing rationale at `main.bicep:628-635`, whose comment says "~11" — the true count is 12; PRs #1736/#1737). **For self-hosting, budget ≥ 2 GiB (ideally ~4 GiB) per worker replica.**
- **⚠️ The Helm chart default will OOM.** `deploy/helm/fabric/values.yaml:74` sets the worker memory **limit to `1Gi`** — **below** the documented ~1.8–2.1 GiB floor (dev already hit "CrashLoopBackOff'd (83 restarts)" at 512 Mi and was bumped to 1.5 Gi). Production values (`values-prod.yaml:44-47`) raise it to `2Gi` / `replicas: 2`. **A self-hoster who keeps the chart defaults will hit the same OOM** — override the worker limit to ≥ 2 GiB.
- **The worker image carries a browser, and it is not free.** Several activities drive Chromium in-process — frame PDF export (`activities/frame-export/generate-pdf.ts`), Weave/agent browser steps (`activities/browser-automation/session-manager.ts`) and the QA test runner. The image therefore installs Chromium plus its shared libraries (`packages/temporal/Dockerfile`, following the same pattern as `packages/mcp-stdio-wrapper/Dockerfile`), at a cost of roughly **+400 MB of image size** — *estimated from layer contents, not measured on a built image*. Two consequences for sizing:
  - **Disk/pull cost** is the visible one but the cheap one: a larger image slows revision rollout and replica cold-start, nothing more.
  - **Memory is the real constraint.** A Chromium instance is **≈300 MB+ RSS** *on top of* the ≈2.1 GiB peak above. Against Fabric's own 3.5 GiB ceiling that leaves roughly 1.4 GiB of headroom — enough for **one** browser at a time, which is why the QA runner executes its cases strictly sequentially rather than fanning them out. **A self-hoster who budgets the minimum 2 GiB has no room for a browser at all**: either raise the limit to ≥ 4 GiB or expect browser-driving activities to OOM the whole worker — and because all 12 in-process workers share the container, that OOM takes down every activity type, not just the browser one.
  - If you do not use PDF export, Weave browser steps, or QA runs, the layer is dead weight you can strip in a fork; nothing else in the worker launches a browser.
- **Scaling caveat (learned the hard way).** Multiplying worker replicas multiplies database connections. Fabric has had a production incident from a starved Postgres pool (#1548), so scale the worker against a **connection budget** (pool size × in-process workers × replicas vs. your Postgres `max_connections`), not blindly. Add a connection pooler (PgBouncer/RDS Proxy) before scaling the worker widely.
- **How the worker gets its Temporal config on Helm.** The chart does **not** deploy a Temporal server. `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` are wired from `.Values.temporal.address` / `.namespace` into the release ConfigMap (`templates/secrets/config-map.yaml:26-27`); the **credentials** (`TEMPORAL_CLOUD_API_KEY` for Cloud, or your mTLS certs for self-hosted TLS) are supplied via the app secret, not the values block. Point `temporal.address` at your own cluster and put the auth material in the secret.

---

## 9. Payload and message-size limits (read this before quoting a number)

**This is the section most likely to mislead a customer if summarized carelessly.** The facts, each verifiable:

1. `deployment/temporal/dynamic-config.yaml` raises **`limit.blobSize`** to **16 MB error / 4 MB warn** (default 2 MB / 256 KB). It sets **only `blobSize`** — there is **no gRPC message-size setting anywhere in the repo** (verified: no `gRPCMaxMessageSize` / `maxMessageSize` / `max_receive_message` in `packages/temporal`, `aspire`, or `deployment`).
2. **That override is only ever applied under local Aspire.** Aspire sets `DYNAMIC_CONFIG_FILE_PATH` and bind-mounts the file (`aspire/Fabric.AppHost/Program.cs:159-160`). The **docker-compose** Temporal service does **not** mount it (`docker-compose.yml:43-64` — only `temporal_data:/etc/temporal`), so it runs at Temporal's **stock 2 MB** blobSize. Production/staging are on **Cloud**, where this dynamic config does not apply either. **Net: the 16 MB blobSize has never been in effect on any server Fabric ships to or runs in anger.**
3. **The real observed ceiling is the 4 MiB gRPC transport limit, not blobSize.** In #1741 a 6.48 MB activity return was rejected at exactly `4194304` bytes (4 MiB) and was fixed by **slimming the payload**, not by raising a limit. `blobSize` governs the size Temporal will *persist*; the gRPC frame size governs what can *transit* client↔server — and Fabric overrides only the former. **✅ Empirically re-measured 2026-07-17** against a real Temporal server **with `blobSize` raised to 16 MB**: activity-return payloads of 1/2/3 MB succeeded; **4/5/8 MB were rejected at exactly `4194304` bytes** — `ResourceExhausted: grpc: received message larger than max (4194589 vs. 4194304)`. This **reproduces #1741's exact byte count** and proves the 16 MB `blobSize` does not raise the transit ceiling. *(Tested via `@temporalio/testing`'s local dev server — a real Temporal server sharing the default 4 MiB gRPC frame — not the `auto-setup:1.28.0` image, and not the full Fabric stack; the complete FR-10 bring-up remains.)*
4. **Fabric's own code is written to stay under 2–4 MB, not 16 MB.** Multiple guards assume the smaller limits: `document-processing.ts:50,90` ("large buffers/arrays through Temporal's gRPC (4 MB message limit)"), `orchestrator/orchestrator-config.ts:164` ("Output Truncation (Temporal 2MB payload limit)"), `orchestrator/phases/completion.ts:840,951` (truncates output that would "blow past Temporal's 2MB payload limit"), and continue-as-new guards in `connector-sync/index.ts:565` and `meeting-transcript-sync.ts:225` ("~4K events / ~4MB").

**What this means for the doc you hand a customer:**

- **Do not present 16 MB as a working payload limit.** The honest statement is: *Fabric's workflows are engineered to keep individual payloads under ~2 MB and activity results under the 4 MB gRPC frame. The `blobSize` override raises the persistence limit but does not raise the gRPC transport limit, which remains at Temporal's default 4 MB unless you also configure `frontend.gRPCMaxMessageSize` on your server.*
- If a customer's workload genuinely needs `>4 MB` activity payloads, they must **both** raise `blobSize` **and** set the gRPC max message size on the frontend service — and then **prove it end-to-end** ([§15](#15-bring-up-validation-checklist)). Fabric has not validated that combination (the 4 MiB rejection above was with `blobSize`=16 MB but the **default** gRPC frame — i.e. exactly the state a customer copying Fabric's config would be in).
- To apply `blobSize` on a self-hosted server at all, you must mount `deployment/temporal/dynamic-config.yaml` and point `DYNAMIC_CONFIG_FILE_PATH` at it (as Aspire does) — the docker-compose setup does not, so copying docker-compose gets you stock 2 MB.

> **Footnote — Fabric's own comments disagree on the number.** Some code comments cite a "4 MB gRPC limit" (`document-processing.ts`, `pm-state-poll-project-workflow.ts:58`) while another cites "2 MiB" (`fetch-backlog-snapshot.test.ts:138`). Temporal's *default* gRPC frame is 4 MB and its *default* `blobSize` is 2 MB, which is likely the source of the mixed references. The practical takeaway is unchanged: the operative ceiling is **single-digit MB and unraised for transport**, so validate empirically rather than trusting any single number.

---

## 10. Payload codec / encryption

**Fabric implements no payload codec (`DataConverter`) today.** The client (`client.ts:125-131`), the schedule client (`client.ts:168-171`), and all 12 workers (`worker.ts`) are constructed **without** a `dataConverter`, so payloads are stored in Temporal's database in Fabric's default (JSON + binary) encoding — readable to anyone with database or Temporal-UI access.

For a **self-hosted** customer this is usually acceptable, because the Temporal cluster and its database live entirely inside the customer's own infrastructure — payloads never leave their trust boundary. If a customer's compliance posture requires payloads encrypted **at rest inside Temporal** (e.g. a strict data-residency or key-custody mandate), a `PayloadCodec` must be added and wired into **all three** construction sites — the `Client`, every `Worker`, and the `ScheduleClient` — using a customer-held key. This is **not built**; it is [Open item Q2](#14-open-items--not-yet-validated). Wiring it in only some places silently leaves a plaintext path.

**The interface a customer-supplied codec must satisfy** is Temporal's standard `PayloadCodec` (from `@temporalio/common`):

```ts
interface PayloadCodec {
  encode(payloads: Payload[]): Promise<Payload[]>; // outbound (before persist/transit) — encrypt here
  decode(payloads: Payload[]): Promise<Payload[]>; // inbound (after read) — decrypt here
}
```

**Where it plugs in.** It attaches through a `DataConverter` at the three sites named above, identically:

```ts
const dataConverter = { payloadCodecs: [ yourCodec ] };
new Client({ connection, namespace, dataConverter });          // packages/temporal/src/client.ts (+ ScheduleClient)
await Worker.create({ /* … */, dataConverter });               // every Worker.create in packages/temporal/src/worker.ts
```

**Fabric-side configuration to enable it.** None exists today — there is **no Fabric env flag that toggles a codec on**. Enabling at-rest payload encryption inside Temporal is a **code change** at those three sites, not a config switch; a customer adds the codec module and supplies its key by env (mirroring Fabric's existing `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_VERSION` convention). Temporal's alternative — a remote **codec server** used only to decrypt payloads in the Temporal Web UI — Fabric does not use, and it is optional (the UI simply shows ciphertext without it).

---

## 11. Connection and security

Connection logic lives in `packages/temporal/src/client.ts` (client + schedule client, used by the web/API tier that *starts* workflows) and in `packages/temporal/src/worker.ts` for the worker's `NativeConnection`. Both resolve the same four modes, in priority order (`client.ts:43-96`) — **but note the fail-closed guard differs between them** (see below):

| Mode | Trigger | What it does | Self-hosted fit |
|---|---|---|---|
| **API key** | `TEMPORAL_CLOUD_API_KEY` set | Temporal Cloud auth; injects system root CAs; `temporal-namespace` metadata | Cloud only |
| **mTLS** | `TEMPORAL_TLS=true` + `TEMPORAL_CLIENT_CERT` + `TEMPORAL_CLIENT_KEY` | Client-certificate auth | **Recommended for self-hosted** with a TLS frontend |
| **TLS, no auth** | `TEMPORAL_TLS=true` only | `tls: true` — "useful for self-hosted with TLS" (`client.ts:74-77`) | Self-hosted with TLS termination but no client certs |
| **Insecure** | none of the above | Plaintext — **fails closed in production** | Local dev only |

Key points for a self-hoster:

- **Env contract:** `TEMPORAL_ADDRESS` (default `localhost:7233`), `TEMPORAL_NAMESPACE` (default `default`), and one of the auth sets above. Set the **same** values for the web/API tier (which starts workflows) and the worker.
- **The client fails closed without TLS in production — the worker does not.** The **client** (web/API tier) throws on startup for an unauthenticated plaintext connection in production (`client.ts:84-94`, SOC 2 CC6.7), overridable only via `TEMPORAL_ALLOW_INSECURE=true`. The **worker** resolves the same four modes but has **no** production fail-closed guard — its insecure branch just logs "[Worker] Using insecure connection" and connects (the connection block inside `run()`, `worker.ts:156-190`). **Implication:** do not rely on the worker to refuse an insecure connection — enforce TLS yourself (give the cluster a TLS frontend and use mode 2 or 3 for both tiers). Do not use `TEMPORAL_ALLOW_INSECURE` for a customer deployment.
- **Correlation headers.** The client attaches a correlation-ID interceptor to every workflow start (`client.ts:128-130`) — no server-side config needed, noted so you are not surprised by the header.

---

## 12. Persistence (Temporal's own database)

Temporal needs its **own** database for workflow history and visibility — this is **separate** from Fabric's application Postgres.

- The local stack points Temporal at the shared Postgres (`DB=postgres12`, `POSTGRES_SEEDS=postgres`, `docker-compose.yml:50-54`). **For production, give Temporal a dedicated database** (Temporal's history and visibility stores are write-heavy and should not share a cluster with Fabric's app data).
- On AWS this is naturally an **RDS Postgres** instance (or Temporal's supported Cassandra/MySQL). The Fabric AWS reference already provisions RDS for the app; provision a **second** database/instance (or at least a separate logical database with its own connection budget) for Temporal.
- **Fabric's worker also needs its own app-database connection** — `DATABASE_URL`. That is Fabric's Postgres, not Temporal's. See [`ENVIRONMENT-VARIABLES.md`](./ENVIRONMENT-VARIABLES.md).
- **The worker connects with an RLS-bypassing role.** Fabric's migrate hook (`packages/database/scripts/apply-rls-direct.ts`, ~line 84) issues the `CREATE ROLE fabric_worker LOGIN … BYPASSRLS` DDL using `WORKER_DB_PASSWORD`; on AWS the prod Terraform provisions that **credential** + connection string (`deploy/terraform/environments/prod/main.tf:184-205`) — it does not create the role itself. `WORKER_RLS_MODE` (default `bypassrls`; `policy` fallback for hosts that forbid the BYPASSRLS attribute — `apply-rls-direct.ts:49`) selects the behavior. The worker therefore relies on Fabric's **application-level** tenant filtering, not database Row-Level Security. **Requirement for a self-hoster:** your Postgres must allow `CREATE ROLE … BYPASSRLS` (standard on RDS/self-managed Postgres). If your managed Postgres forbids the `BYPASSRLS` attribute, set `WORKER_RLS_MODE=policy` to use the RLS-subject fallback role instead.
- **No Fabric-specific schema on Temporal's own store.** Fabric runs **zero** custom migrations against Temporal's persistence/visibility database — Temporal owns and manages that schema (the `auto-setup` image provisions it; on the plain `server` image you run Temporal's standard `temporal-sql-tool` schema setup). Fabric's only requirement is that Temporal has a dedicated database it can own. (Confirmed: no `temporal`-targeted migrations exist in the repo.)

---

## 13. External dependencies of the workflows

What Fabric's activities call out to, and for each: is it **required**, and is it **self-hostable** or **cloud-locked**? This is the section a data-residency-sensitive customer cares about most. Each row is cited; `REQUIRED` means core features break without it, `OPTIONAL` means a feature degrades or is unavailable.

| Service | Role | Required? | Self-hostable? | Env / evidence |
|---|---|---|---|---|
| **Postgres** (app) | Fabric's own data | **Required** | Yes (RDS/any Postgres) | `DATABASE_URL` |
| **Temporal DB** | Workflow history/visibility | **Required** | Yes | see §12 |
| **Qdrant** | Vector DB for RAG / embeddings | **Required** for RAG-dependent features | **Yes** (Qdrant is OSS; the AWS chart ships an in-cluster default per `EXTERNAL-SERVICES.md`) | `QDRANT_URL` / `QDRANT_API_KEY` — **embedding dims pinned to 1536** (`vector-store/client.ts:16`) |
| **Object storage (S3/MinIO)** | Attachments, document blobs, code-index artifacts | **Required** for attachments/docs | **Yes** — S3-compatible, defaults to **`minio`** (`packages/storage/provider/index.ts:28`); use AWS S3 natively | `STORAGE_PROVIDER` (default `minio`), S3 endpoint/keys/bucket |
| **Redis** | Caching, rate-limit throttles, some coordination | **Recommended** (degrades, not fatal) | **Yes** (OSS Redis / ElastiCache) | `CACHE_HOST` / `REDIS_URL` / `rediss://` |
| **AI provider(s)** | LLM + embeddings for scans, reports, summaries, code-index, orchestrator | **Required** (≥1) | Provider-dependent | AI Gateway / provider keys — see below |
| **Cloudflare sandbox** | Sandboxed code execution | **Optional** (only if the feature is used) | **Yes — not Cloudflare-locked** | `SANDBOX_WORKER_URL` (plain fetch to a configurable base; `packages/sandbox/src/client.ts:75,288` — no hard-coded host) |
| **Firecrawl** | Web scraping / URL ingestion | **Optional** (URL-source feature) | **NO — cloud-locked** | Hard-codes `https://api.firecrawl.dev/v1` with **no override** (`packages/temporal/src/activities/lib/firecrawl-client.ts:19`) |
| **Upstash** | Serverless Redis (web/API tier) | Not a worker/Temporal dependency | n/a for Temporal | Used by the web tier, not the workflows |
| **Email** | Newsletter, report, and notification emails | **Optional** | **No — Resend only** | The sole shipped provider is **Resend** (`packages/mail/src/provider/index.ts` re-exports `./resend`); avoiding Resend means implementing a new provider (a code change). Degrades to `false`, doesn't crash |
| **PM tools, Slack/Teams, GitHub/GitLab, MS Graph, fal.ai** | Integration side-effects | **Optional** per feature | Mostly cloud-locked vendor APIs (customer-configured, per-tenant OAuth/PAT) | Per-integration keys — see note below |
| **Letta** (agent long-term memory) | Optional agent memory | **Optional** | **Yes** (OSS) | `LETTA_BASE_URL` / `LETTA_API_KEY`; unset → degrades |

**Corrections to earlier assumptions (verified in code):**

- **Cloudflare sandbox is NOT cloud-locked.** `packages/sandbox/src/client.ts` fetches `${baseUrl}${path}` where `baseUrl` comes from `SANDBOX_WORKER_URL` (`:288`, throws if unset), with no hard-coded Cloudflare host — so it is self-hostable by pointing that env var at any compatible worker.
- **Firecrawl IS the real data-residency red flag.** `firecrawl-client.ts:19` pins `https://api.firecrawl.dev/v1` with no base-URL env override. Any customer using URL-source/scraping features sends that content to Firecrawl's cloud. Flag this explicitly to a residency-sensitive customer; if it's a blocker, the URL-source feature must be disabled or the client must gain a configurable base URL (a code change).
- **Object storage defaults to MinIO** (S3-compatible), not Azure Blob — so an AWS self-hoster uses S3 natively with no code change.
- **Self-managed GitLab / GitHub Enterprise support is inconsistent — verify per feature.** The **PM story-sync** path hard-codes `https://gitlab.com/api/v4` and its source states "self-hosted GitLab is not yet supported by the workflow integration record" (`activities/pm-source.ts:33-36`), so **PM sync against a self-hosted GitLab does not work today**. The **connector-sync** path, by contrast, *does* accept a custom GitLab base URL (`normalizeGitLabApiBaseUrl(baseUrl)`, `connector-sync/providers/collaboration.ts:47`). GitHub call sites checked hard-code `api.github.com` with no GitHub-Enterprise host override (`collaboration.ts:137`). Net: a customer on self-managed GitLab / GitHub Enterprise should expect **partial** integration support — confirm the specific features they need before promising them.
- **Email is Resend-only.** The active provider is Resend (`packages/mail/src/provider/index.ts` → `export * from "./resend"`), and it is the only provider implementation that ships — the previously bundled SMTP/nodemailer alternative was removed as dead code. A self-hoster who wants to avoid Resend must implement a new provider behind the same `SendEmailHandler` interface (a code change, not configuration).

**AI providers and residency.** Fabric resolves every AI call through **one factory** (`packages/ai/model-factory.ts`), with credentials/base-URL resolved per-tenant from the DB or a global `AI_GATEWAY_API_KEY`. Residency must be described carefully — do **not** over-promise it: **`AZURE_AI_FOUNDRY` (`model-factory.ts:771`) and `DATABRICKS` (`:853`) are genuinely implemented** in-region paths. **`AWS_BEDROCK` and `GOOGLE_VERTEX_AI` are declared in the provider type union but *not* implemented** — they have no switch case and fall through to the OpenAI-compatible `default` branch (`:868`), and `packages/ai` ships no Bedrock/Vertex SDK, so wiring them for real (SigV4 / GCP auth) is a **code change, not configuration**. So an AWS customer wanting in-region inference today should use a supported path (Azure Foundry, Databricks, or an OpenAI-compatible in-region gateway); **native Bedrock/Vertex would need implementation first** and belongs in [Open item Q3](#14-open-items--not-yet-validated). Public providers carry hard-coded hosts (`api.openai.com`, `api.anthropic.com`), plus one minor lock: OpenAI text-to-speech is hard-coded (`agent-executor.ts:865`, optional TTS tool). Every AI-bearing workflow funnels through this factory — note the **1536-dim embedding constraint** above when choosing an embedding model.

---

## 14. Open items — not yet validated

These require a decision or a live test before this document is customer-final. None is a blocker to *reading* the requirements; each is a blocker to *promising* them.

- **Q1 — `auto-setup` vs `server` image for production.** Fabric has only run `auto-setup`. Decide whether a production customer runs `auto-setup` or the plain `server` image with explicit schema/namespace setup, and document the chosen path.
- **Q2 — Payload codec.** Not built. Decide whether v1 self-hosting ships without at-rest payload encryption inside Temporal (acceptable if the cluster is fully in-customer-infra) or whether a `DataConverter` is committed before the first self-hosted customer. See §10.
- **Q3 — AWS/residency assumptions.** RDS for Temporal persistence, mTLS creds from Secrets Manager, in-region AI (Bedrock?) — all depend on the customer's actual compliance constraints. Get these blessed.
- **Q4 — The `>4 MB` payload reality (highest priority).** The real usable ceiling on a self-hosted server is **untested**. If a customer workload can produce `>4 MB` activity payloads, §15's payload test must run first; otherwise "raise blobSize" is misleading. See §9.

---

## 15. Bring-up validation checklist

**This gate is mandatory** because a self-hosted *production* Temporal cluster is a configuration Fabric has never run. It should be executed by someone **other than the document author** (author shouldn't grade the doc), using **only** this document, on a clean-room cluster.

1. **Stand up** a Temporal server (chosen image per Q1) with its own database, TLS frontend, and the `default` (or chosen) namespace registered.
2. **Apply `blobSize`** by mounting `deployment/temporal/dynamic-config.yaml` and setting `DYNAMIC_CONFIG_FILE_PATH` — and, if `>4 MB` payloads are in scope, **also** set the frontend gRPC max message size.
3. **Point Fabric** at it: set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and the TLS/mTLS env (mode 2 or 3). Confirm the worker connects and **all 12 task queues** are polled.
4. **Confirm schedule registration:** check the Temporal UI shows the Schedules from `registerSystemSchedules()` after worker boot; enable the opt-in retention flags you intend to run and confirm those appear too.
5. **Exercise each queue's happy path:** trigger a chat title, a document generation (RAG → exercises Qdrant + storage), a code-index run, a scan, a report, a PM sync. Confirm activities that call external services (Qdrant, storage, AI) succeed against the customer's endpoints.
6. **Run the payload test (Q4):** push a **`>4 MB`** activity payload through a real workflow (e.g. a large code-analysis result) and record what happens — success, or rejection at `4194304` bytes. **This is the single most important test**; its result determines whether "raise blobSize" is safe advice.
7. **Record the results** back into this document (image chosen, payload ceiling observed, any dependency that needed a customer endpoint) so the next self-hoster inherits validated facts, not assumptions.

---

## 16. Environment variable reference

The Temporal-specific contract (see [`ENVIRONMENT-VARIABLES.md`](./ENVIRONMENT-VARIABLES.md) for the full app set):

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `TEMPORAL_ADDRESS` | Server host:port | `localhost:7233` | `client.ts:19` |
| `TEMPORAL_NAMESPACE` | Namespace | `default` | must match client + worker (`client.ts:20`) |
| `TEMPORAL_TLS` | Enable TLS | — | `true` enables mode 2/3 (`client.ts:22`) |
| `TEMPORAL_CLIENT_CERT` / `TEMPORAL_CLIENT_KEY` | mTLS client cert/key | — | mode 2 (`client.ts:60-67`) |
| `TEMPORAL_CLOUD_API_KEY` | Temporal Cloud API key | — | Cloud only; leave unset when self-hosting |
| `TEMPORAL_ALLOW_INSECURE` | Emergency plaintext override in prod | — | **do not use for customer deployments** (`client.ts:86`) |
| `DYNAMIC_CONFIG_FILE_PATH` | Path to `dynamic-config.yaml` (server-side) | — | required to apply `blobSize` (§9) |
| `FABRIC_AUDIT_LOG_RETENTION_ENABLED` etc. | Opt-in retention schedules | off | §6 |
| `STORAGE_PROVIDER` | Object-storage backend | `minio` | `s3` for AWS (`storage/provider/index.ts:28`) |
| `SANDBOX_WORKER_URL` | Sandbox base URL | — | self-hostable (§13) |
| `QDRANT_URL` / `QDRANT_API_KEY` | Vector DB | — | in-cluster default available (§13) |
| `CACHE_HOST` / `REDIS_URL` | Redis | — | recommended (§13) |

---

## 17. AWS-specific caveats

Known configuration caveats for running Fabric's Temporal on AWS (beyond what §12 covers):

- **gRPC 4 MB frame vs. AWS load balancers.** Temporal is gRPC (HTTP/2) on `7233`. If you front the frontend service with a load balancer, use an **NLB** (or an ALB with HTTP/2/gRPC target support) — a classic/HTTP-1 LB will break streaming and long calls. And recall (§9) the real payload ceiling is the **4 MB gRPC frame**, not the 16 MB `blobSize`; that limit is enforced by the frontend regardless of the LB.
- **Persistence = RDS Postgres (or Aurora / self-managed).** Temporal's own store (§12) maps naturally to **RDS Postgres**; Cassandra/MySQL are also Temporal-supported. Give it its own instance/database — do not co-locate with Fabric's app DB. No Fabric-specific schema is imposed (§12).
- **mTLS material from Secrets Manager.** For a hardened cluster, terminate TLS at the frontend and use **mode 2 (mTLS)** — source `TEMPORAL_CLIENT_CERT`/`TEMPORAL_CLIENT_KEY` from AWS Secrets Manager (the self-hosted chart already wires secrets via `external-secrets`).
- **AWS Bedrock does not change Temporal config — but it is not usable today.** Using Bedrock for in-region inference is an **AI-provider** decision, not a Temporal one: no namespace, task-queue, or codec change is required for it. **However**, `AWS_BEDROCK` is currently **declared but not implemented** in Fabric's model factory (`packages/ai/model-factory.ts` — no provider case, no Bedrock SDK; it falls through to an OpenAI-compatible default). So "self-host Temporal **with Bedrock**" needs the Bedrock provider built first; the implemented in-region options are **Azure Foundry, Databricks, or an OpenAI-compatible in-region gateway**. This is the one AWS/residency assumption a customer is most likely to trip over.
- **Region / residency.** Everything Fabric's workflows touch stays in the customer's account/region **except** the cloud-locked egress noted in §13 (Firecrawl → `api.firecrawl.dev`, if the URL-source feature is used). Disable that feature or request a configurable base URL for full in-region residency.

---

## 18. Document control (currency & sign-off)

- **Last validated against:** latest `origin/master` @ `7db310b6b` (this branch is rebased onto it), 2026-07-17 — every version, namespace, task-queue, search-attribute, and dependency claim was re-checked against the live code at that master, not from memory (per the card's Data & Validation Rules). Confirmed none of the cited source files changed between the earlier baseline and this master.
- **Update triggers:** re-verify when the worker's `Worker.create` set changes (task queues), when `schedules.ts` changes (schedules), when `@temporalio/*` is bumped (version), or when a new external dependency is added to an activity.
- **Changelog:**
  - 2026-07-16 — initial authoring; validated against live code.
  - 2026-07-17 — added the `PayloadCodec` interface/contract (FR-5), AWS-specific caveats incl. the Bedrock flag (FR-7), the no-custom-schema note, and this control block (FR-9).
  - 2026-07-17 — **payload ceiling empirically re-measured** against a real Temporal server (§9): 4 MiB gRPC frame confirmed at exactly `4194304` bytes with `blobSize`=16 MB.
  - 2026-07-17 — independent verification pass (fresh context vs. live code, verdict: accurate); corrected the §12 BYPASSRLS attribution (role DDL is `apply-rls-direct.ts:84`, not Terraform) + citation nits; rebased onto latest `origin/master` @ `7db310b6b` and re-verified.
- **Partially validated:**
  - **FR-10 (payload portion) — done.** The §9 payload-ceiling claim is now measured on a real Temporal server, not asserted (see §9). The runbook to reproduce it, plus the full bring-up, is `FR10_Temporal_Bringup_Test.md`.
  - **FR-10 (full bring-up) — not done.** The full Fabric stack has not yet been exercised end-to-end against a self-hosted Temporal cluster across all 12 queues (the §15 bring-up). The payload sub-test above is done; the whole-stack bring-up is not.

---

*Last validated against `master` @ `7db310b6b`. Source-of-truth files: `packages/temporal/src/client.ts`, `packages/temporal/src/worker.ts`, `packages/temporal/src/schedules.ts`, `deployment/temporal/dynamic-config.yaml`, `aspire/Fabric.AppHost/Program.cs`.*

# @repo/api

## 0.0.4

### Patch Changes

- Updated dependencies [a7feb71]
  - @repo/temporal@0.0.4
  - @repo/auth@0.0.4

## 0.0.3

### Patch Changes

- 9e8e50e: Add secure QA webhooks, reusable zero-model scripted test runs, selectable historical agent evidence, and append-only test-script revision history.
- 44bad17: Add on-demand summary and action items for personal calendar meetings. The transcript is summarised in-request and returned without being stored, so the never-persisted guarantee for personal meetings is unchanged; insights are regenerated each time they are asked for and there is no ticket creation.
- 316ea53: Workflow builder: API keys for triggering a published workflow's webhook can now be created, listed and revoked. The webhook route has verified bearer tokens since it shipped, but nothing could create one, so that authentication path was unreachable and HMAC signatures were the only option. The raw key is shown once and only its hash is stored.
- 376a041: Workflow builder: the Schedule trigger now works. Choosing "Schedule" has been offered since the builder shipped but never created anything, so a scheduled workflow simply never ran. Publishing a workflow whose trigger carries a cron now registers a Temporal Schedule; unpublishing or deleting removes it; and editing the cron on a published workflow takes effect without a republish. Each fire gets its own execution record, so scheduled runs appear in run history exactly like manual ones.
- 316ea53: Workflow builder: "generate code" now covers every node type instead of twelve. It previously emitted a comment rather than the operation for most types it knew about, and a bare "Unknown node type" line for everything else — so a workflow built from the integrations that make up most of the palette generated essentially nothing. The output is now a faithful transcription of the graph: every step in dependency order, with its real configuration and its references to upstream outputs resolved. It is labelled as a scaffold, because it is one.
- 19d9910: Workflow builder: a running execution can now be cancelled from the execution panel. Cancelling records the run as cancelled rather than failed and keeps the output of nodes that already finished, and an execution can no longer be left stuck in RUNNING when Temporal is unreachable. Adds two execution bounds that were absent entirely: a wall-clock ceiling on a single run, and a node-count limit enforced when a workflow is saved or published rather than part-way through a run.
- ad11c38: Workflow builder: a workspace can no longer start unlimited workflow executions at once — a runaway caller or retry storm previously held every worker slot on the shared queue, starving other tenants. Organizations can raise their own ceiling through the existing deployment quota. The webhook trigger's rate limit is now shared across instances rather than counted per process, where N instances meant N times the intended limit and every deploy reset the counter.
- bf41584: Workflow builder: adds five integrations ported from the upstream template — Stripe (create/get customer, create invoice), Webflow (list/get/publish site), Clerk (get/create/update/delete user), Superagent (guard, redact) and Vercel Blob (upload, list). Each ships with credential fields, a connection test and a step executor. Requires a migration adding the new provider values.
- Updated dependencies [9e8e50e]
- Updated dependencies [19d9910]
- Updated dependencies [19d9910]
- Updated dependencies [376a041]
- Updated dependencies [19d9910]
- Updated dependencies [19d9910]
- Updated dependencies [bf41584]
- Updated dependencies [19d9910]
- Updated dependencies [376a041]
  - @repo/database@0.0.3
  - @repo/integrations@0.0.3
  - @repo/rag@0.0.3
  - @repo/temporal@0.0.3
  - @repo/utils@0.0.1
  - @repo/agent-core@0.1.3
  - @repo/ai@0.0.3
  - @repo/atlas@0.0.3
  - @repo/auth@0.0.3
  - @repo/connectors@0.0.3
  - @repo/mcp@0.0.4
  - @repo/openapi-tools@0.0.3
  - @repo/payments@0.0.3
  - @repo/search@0.0.3
  - @repo/logs@0.0.1
  - @repo/mail@0.0.1
  - @repo/storage@0.0.1

## 0.0.2

### Patch Changes

- Updated dependencies [2a6e543]
  - @repo/database@0.0.2
  - @repo/temporal@0.0.2
  - @repo/agent-core@0.1.2
  - @repo/ai@0.0.2
  - @repo/atlas@0.0.2
  - @repo/auth@0.0.2
  - @repo/connectors@0.0.2
  - @repo/integrations@0.0.2
  - @repo/mcp@0.0.3
  - @repo/openapi-tools@0.0.2
  - @repo/payments@0.0.2
  - @repo/rag@0.0.2
  - @repo/search@0.0.2

## 0.0.1

### Patch Changes

- 3d36eb3: Stop the agent health monitor from marking non-probeable system agents as "Error". In-process `FABRIC_NATIVE` agents (the canonical workspace assistant) and inline agents registered with an empty `deploymentUrl` (e.g. Sidekick) have no external `/health` endpoint, so probing them only ever produced a false ERROR. A shared `isProbeableAgent` predicate now excludes them from both the Temporal monitor and the manual "Check health" procedure, and a data migration clears the latched ERROR state they had accumulated. Also adds the missing `backlog_updater` entry to the agent URL resolver maps. Follow-up to #1685.
- be2bb59: Include `lastHealthError` and `consecutiveHealthFailures` in the `agents.registry.list` output schema. The oRPC `.output()` schema was stripping these two health fields, so the Agents page ERROR-pill tooltip never received `lastHealthError`. Follow-up to #1685, found during staging verification.
- 5ad88a5: Fix System Agents falsely showing "Error" on the Agents page. The health monitor probed the raw stored `deploymentUrl` while the orchestrator probes a resolved URL (`resolveAgentUrl`), so reachable system agents were marked ERROR. The monitor activity and the manual "Check health" procedure now resolve the URL the same way; an agent only flips to ERROR after 3 consecutive failed probes (instead of one); and the probe-failure reason (resolved URL + cause) is persisted to `lastHealthError` and surfaced as a tooltip on the status pill. Fixes Bug #1685.
- Updated dependencies [044a9f7]
- Updated dependencies [3d36eb3]
- Updated dependencies [a03d88d]
- Updated dependencies [f42cf1e]
- Updated dependencies [1a8fc05]
- Updated dependencies [6f8e223]
- Updated dependencies [5ad88a5]
  - @repo/database@0.0.1
  - @repo/temporal@0.0.1
  - @repo/ai@0.0.1
  - @repo/agent-core@0.1.1
  - @repo/auth@0.0.1
  - @repo/code-understanding@0.0.1
  - @repo/connectors@0.0.1
  - @repo/integrations@0.0.1
  - @repo/mcp@0.0.2
  - @repo/openapi-tools@0.0.1
  - @repo/payments@0.0.1
  - @repo/rag@0.0.1
  - @repo/search@0.0.1

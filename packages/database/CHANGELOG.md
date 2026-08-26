# @repo/database

## 0.0.3

### Patch Changes

- 9e8e50e: Add secure QA webhooks, reusable zero-model scripted test runs, selectable historical agent evidence, and append-only test-script revision history.
- bf41584: Workflow builder: adds five integrations ported from the upstream template — Stripe (create/get customer, create invoice), Webflow (list/get/publish site), Clerk (get/create/update/delete user), Superagent (guard, redact) and Vercel Blob (upload, list). Each ships with credential fields, a connection test and a step executor. Requires a migration adding the new provider values.
- Updated dependencies [9e8e50e]
  - @repo/utils@0.0.1
  - @repo/logs@0.0.1
  - @repo/databricks@0.0.1
  - @repo/storage@0.0.1

## 0.0.2

### Patch Changes

- 2a6e543: Self-heal non-probeable agents to ACTIVE on every health-monitor cycle. In-process `FABRIC_NATIVE` agents and inline agents (empty `deploymentUrl`) are never probed, so once they were left STALE or ERROR — e.g. by an older monitor build or a deploy-order race with the one-shot reset migration — nothing flipped them back. The `markStaleAgents` activity now also calls a new `reactivateNonProbeableAgents` query that resets them to ACTIVE (clearing `consecutiveHealthFailures` / `lastHealthError`) each cycle, independent of migration timing. The monitor workflow's activity-call sequence is unchanged, so there is no Temporal replay impact. Follow-up to #1685.

## 0.0.1

### Patch Changes

- 044a9f7: Stop the agent staleness sweep from marking non-probeable system agents as "Stale". `markStaleAgentsInactive` flipped any ACTIVE agent with a non-null `deploymentUrl` and a lapsed `lastHealthCheck` to STALE — but in-process `FABRIC_NATIVE` agents and inline agents (empty `deploymentUrl`) are no longer probed (#1685 follow-up), so their `lastHealthCheck` never refreshes and they were turned STALE instead of staying ACTIVE. The sweep now excludes them, a migration resets the rows already mislabeled, and the Agents page renders the `STALE` status with its own pill (previously it fell through to "Inactive"). Follow-up to #1685.
- 3d36eb3: Stop the agent health monitor from marking non-probeable system agents as "Error". In-process `FABRIC_NATIVE` agents (the canonical workspace assistant) and inline agents registered with an empty `deploymentUrl` (e.g. Sidekick) have no external `/health` endpoint, so probing them only ever produced a false ERROR. A shared `isProbeableAgent` predicate now excludes them from both the Temporal monitor and the manual "Check health" procedure, and a data migration clears the latched ERROR state they had accumulated. Also adds the missing `backlog_updater` entry to the agent URL resolver maps. Follow-up to #1685.
- 5ad88a5: Fix System Agents falsely showing "Error" on the Agents page. The health monitor probed the raw stored `deploymentUrl` while the orchestrator probes a resolved URL (`resolveAgentUrl`), so reachable system agents were marked ERROR. The monitor activity and the manual "Check health" procedure now resolve the URL the same way; an agent only flips to ERROR after 3 consecutive failed probes (instead of one); and the probe-failure reason (resolved URL + cause) is persisted to `lastHealthError` and surfaced as a tooltip on the status pill. Fixes Bug #1685.

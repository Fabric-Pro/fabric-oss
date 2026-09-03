# @repo/temporal

## 0.0.4

### Patch Changes

- a7feb71: Stop sending the internal staging hostname in the PM-sync worker's User-Agent

## 0.0.3

### Patch Changes

- 9e8e50e: Add secure QA webhooks, reusable zero-model scripted test runs, selectable historical agent evidence, and append-only test-script revision history.
- 19d9910: Workflow builder: node types are now pinned on the action that owns them rather than derived from the integration name, so the AI, Slack, email and MCP nodes keep the names every saved workflow already uses. Removes the fuzzy node-type matching that could resolve a GitHub node to the GitLab integration. Also wires up GitLab "Get File Contents", whose executor was fully implemented but reachable from nowhere.
- 19d9910: Workflow builder: fields an action advertises for `{{Node.field}}` autocomplete are now guaranteed to be fields its step actually returns — five actions (Linear, Slack, Resend and both Firecrawl actions) advertised names their steps never set. An unresolved reference now resolves to empty and is reported instead of being delivered verbatim, so a workflow can no longer post the literal text "{{Create Ticket.id}}" to a real channel. Adds a contract test that fails the build on any new mismatch, and end-to-end coverage of the builder's save/reload round-trip.
- 376a041: Workflow builder: the Schedule trigger now works. Choosing "Schedule" has been offered since the builder shipped but never created anything, so a scheduled workflow simply never ran. Publishing a workflow whose trigger carries a cron now registers a Temporal Schedule; unpublishing or deleting removes it; and editing the cron on a published workflow takes effect without a republish. Each fire gets its own execution record, so scheduled runs appear in run history exactly like manual ones.
- 19d9910: Workflow builder: namespace every integration step key by its provider, so `create-ticket` is no longer ambiguous across Linear, Zendesk and Freshservice; workflows saved under the old bare keys keep running via an alias map, with a backfill script to rewrite stored definitions. Nodes that write to an external source (create a ticket, send a message, file an issue) are no longer automatically retried, so an infrastructure failure after the write landed can no longer duplicate it. A workflow step the worker cannot execute now reports failure instead of reporting success and doing nothing.
- 19d9910: Workflow builder: a running execution can now be cancelled from the execution panel. Cancelling records the run as cancelled rather than failed and keeps the output of nodes that already finished, and an execution can no longer be left stuck in RUNNING when Temporal is unreachable. Adds two execution bounds that were absent entirely: a wall-clock ceiling on a single run, and a node-count limit enforced when a workflow is saved or published rather than part-way through a run.
- bf41584: Workflow builder: adds five integrations ported from the upstream template — Stripe (create/get customer, create invoice), Webflow (list/get/publish site), Clerk (get/create/update/delete user), Superagent (guard, redact) and Vercel Blob (upload, list). Each ships with credential fields, a connection test and a step executor. Requires a migration adding the new provider values.
- 19d9910: Workflow builder: independent branches now run concurrently instead of strictly one after another, and a node can be disabled without deleting it. Node configuration is no longer written to logs in full. The AI node's Model field no longer claims to be required — model selection is governed by workspace settings, and the field now says so rather than asking for a choice it ignores.
- 376a041: Workflow builder: a sweep that removes schedules whose workflow was deleted, unpublished, or switched away from a Schedule trigger. Schedule sync is deliberately best-effort so a publish is never blocked by Temporal being briefly unreachable; this closes the gap that leaves behind, where a schedule would otherwise keep firing against nothing.
- Updated dependencies [9e8e50e]
- Updated dependencies [bf41584]
  - @repo/database@0.0.3
  - @repo/integrations@0.0.3
  - @repo/rag@0.0.3
  - @repo/sandbox@0.0.2
  - @repo/utils@0.0.1
  - @repo/agent-core@0.1.3
  - @repo/ai@0.0.3
  - @repo/atlas@0.0.3
  - @repo/connectors@0.0.3
  - @repo/fabric-ai@0.0.3
  - @repo/mcp@0.0.4
  - @repo/search@0.0.3
  - @repo/weave-core@0.1.3
  - @repo/evidence@0.0.1
  - @repo/logs@0.0.1
  - @repo/mail@0.0.1
  - @repo/storage@0.0.1

## 0.0.2

### Patch Changes

- 2a6e543: Self-heal non-probeable agents to ACTIVE on every health-monitor cycle. In-process `FABRIC_NATIVE` agents and inline agents (empty `deploymentUrl`) are never probed, so once they were left STALE or ERROR — e.g. by an older monitor build or a deploy-order race with the one-shot reset migration — nothing flipped them back. The `markStaleAgents` activity now also calls a new `reactivateNonProbeableAgents` query that resets them to ACTIVE (clearing `consecutiveHealthFailures` / `lastHealthError`) each cycle, independent of migration timing. The monitor workflow's activity-call sequence is unchanged, so there is no Temporal replay impact. Follow-up to #1685.
- Updated dependencies [2a6e543]
  - @repo/database@0.0.2
  - @repo/agent-core@0.1.2
  - @repo/ai@0.0.2
  - @repo/atlas@0.0.2
  - @repo/connectors@0.0.2
  - @repo/fabric-ai@0.0.2
  - @repo/integrations@0.0.2
  - @repo/mcp@0.0.3
  - @repo/rag@0.0.2
  - @repo/search@0.0.2
  - @repo/weave-core@0.1.2

## 0.0.1

### Patch Changes

- 3d36eb3: Stop the agent health monitor from marking non-probeable system agents as "Error". In-process `FABRIC_NATIVE` agents (the canonical workspace assistant) and inline agents registered with an empty `deploymentUrl` (e.g. Sidekick) have no external `/health` endpoint, so probing them only ever produced a false ERROR. A shared `isProbeableAgent` predicate now excludes them from both the Temporal monitor and the manual "Check health" procedure, and a data migration clears the latched ERROR state they had accumulated. Also adds the missing `backlog_updater` entry to the agent URL resolver maps. Follow-up to #1685.
- a03d88d: AI Update (generate path): classify and surface a clear, actionable error instead of an opaque "Analysis failed" / "Activity task failed" card. The backlog-context analysis activity now maps provider-not-configured, quota, rate-limit, context-length, and schema-parse failures to specific messages and logs a self-diagnosing line (errorClass + provider + cause); the workflow unwraps the activity failure so the classified message reaches the user. Fixes Bug #391.
- f42cf1e: AI Update: fix "encounters an error on execution" on Azure AI Foundry (#1681).
- 1a8fc05: AI Update: classify retried / `RetryError`-wrapped provider errors (#1681).
- 5ad88a5: Fix System Agents falsely showing "Error" on the Agents page. The health monitor probed the raw stored `deploymentUrl` while the orchestrator probes a resolved URL (`resolveAgentUrl`), so reachable system agents were marked ERROR. The monitor activity and the manual "Check health" procedure now resolve the URL the same way; an agent only flips to ERROR after 3 consecutive failed probes (instead of one); and the probe-failure reason (resolved URL + cause) is persisted to `lastHealthError` and surfaced as a tooltip on the status pill. Fixes Bug #1685.
- Updated dependencies [044a9f7]
- Updated dependencies [3d36eb3]
- Updated dependencies [1a8fc05]
- Updated dependencies [6f8e223]
- Updated dependencies [5ad88a5]
  - @repo/database@0.0.1
  - @repo/ai@0.0.1
  - @repo/agent-core@0.1.1
  - @repo/code-understanding@0.0.1
  - @repo/connectors@0.0.1
  - @repo/fabric-ai@0.0.1
  - @repo/integrations@0.0.1
  - @repo/mcp@0.0.2
  - @repo/rag@0.0.1
  - @repo/search@0.0.1
  - @repo/weave-core@0.1.1

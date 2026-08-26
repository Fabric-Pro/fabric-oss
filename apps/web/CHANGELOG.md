# @repo/web

## 0.0.4

### Patch Changes

- 19d9910: Workflow builder: the AI node no longer asks for a model. Model selection is governed centrally in Settings → AI Models, and the step has always resolved the model from the workspace default — the field asked for a decision it then discarded. Existing workflows are unaffected: they already ran on the workspace default.
- 9e8e50e: Add secure QA webhooks, reusable zero-model scripted test runs, selectable historical agent evidence, and append-only test-script revision history.
- 8e4694e: Render QA pipeline filters, findings, and failure banners with translated copy.
- 5a4dfe7: Render the QA segment About control with its translated accessible label.
- 398cfc8: Keep the filename visible on a failed context-upload row.
- 2851abb: Fix personal meeting insights and transcript state leaking between meetings. Summarising one meeting and then opening another showed the second already summarised, which fetched its transcript without the user asking.
- 3e26c29: Resolve QA pipeline copy from the feature QA translation namespace and guard every literal QA translation namespace against drift.
- 44bad17: Add on-demand summary and action items for personal calendar meetings. The transcript is summarised in-request and returned without being stored, so the never-persisted guarantee for personal meetings is unchanged; insights are regenerated each time they are asked for and there is no ticket creation.
- 19d9910: Workflow builder: the action palette is now derived from the integration registry instead of a hand-maintained list, taking it from 18 node types to 44. Asana, Attio, Bitbucket, Canva, ClickUp, Freshservice, Front, GitLab, HubSpot, Intercom, Jira, Salesforce and Zendesk actions can now be placed on a canvas — their executors already existed but nothing offered them. Actions with no executor behind them are never offered. Plugin-backed nodes render their configuration from the integration's own field declaration, so they pick up template inputs, schema builders and conditional fields that the old shared editor could not express.
- 19d9910: Workflow builder: node types are now pinned on the action that owns them rather than derived from the integration name, so the AI, Slack, email and MCP nodes keep the names every saved workflow already uses. Removes the fuzzy node-type matching that could resolve a GitHub node to the GitLab integration. Also wires up GitLab "Get File Contents", whose executor was fully implemented but reachable from nowhere.
- 19d9910: Workflow builder: fields an action advertises for `{{Node.field}}` autocomplete are now guaranteed to be fields its step actually returns — five actions (Linear, Slack, Resend and both Firecrawl actions) advertised names their steps never set. An unresolved reference now resolves to empty and is reported instead of being delivered verbatim, so a workflow can no longer post the literal text "{{Create Ticket.id}}" to a real channel. Adds a contract test that fails the build on any new mismatch, and end-to-end coverage of the builder's save/reload round-trip.
- 376a041: Workflow builder: the Schedule trigger now works. Choosing "Schedule" has been offered since the builder shipped but never created anything, so a scheduled workflow simply never ran. Publishing a workflow whose trigger carries a cron now registers a Temporal Schedule; unpublishing or deleting removes it; and editing the cron on a published workflow takes effect without a republish. Each fire gets its own execution record, so scheduled runs appear in run history exactly like manual ones.
- 19d9910: Workflow builder: namespace every integration step key by its provider, so `create-ticket` is no longer ambiguous across Linear, Zendesk and Freshservice; workflows saved under the old bare keys keep running via an alias map, with a backfill script to rewrite stored definitions. Nodes that write to an external source (create a ticket, send a message, file an issue) are no longer automatically retried, so an infrastructure failure after the write landed can no longer duplicate it. A workflow step the worker cannot execute now reports failure instead of reporting success and doing nothing.
- 19d9910: Workflow builder: a running execution can now be cancelled from the execution panel. Cancelling records the run as cancelled rather than failed and keeps the output of nodes that already finished, and an execution can no longer be left stuck in RUNNING when Temporal is unreachable. Adds two execution bounds that were absent entirely: a wall-clock ceiling on a single run, and a node-count limit enforced when a workflow is saved or published rather than part-way through a run.
- ad11c38: Workflow builder: a workspace can no longer start unlimited workflow executions at once — a runaway caller or retry storm previously held every worker slot on the shared queue, starving other tenants. Organizations can raise their own ceiling through the existing deployment quota. The webhook trigger's rate limit is now shared across instances rather than counted per process, where N instances meant N times the intended limit and every deploy reset the counter.
- bf41584: Workflow builder: adds five integrations ported from the upstream template — Stripe (create/get customer, create invoice), Webflow (list/get/publish site), Clerk (get/create/update/delete user), Superagent (guard, redact) and Vercel Blob (upload, list). Each ships with credential fields, a connection test and a step executor. Requires a migration adding the new provider values.
- 19d9910: Workflow builder: independent branches now run concurrently instead of strictly one after another, and a node can be disabled without deleting it. Node configuration is no longer written to logs in full. The AI node's Model field no longer claims to be required — model selection is governed by workspace settings, and the field now says so rather than asking for a choice it ignores.
- Updated dependencies [9e8e50e]
- Updated dependencies [44bad17]
- Updated dependencies [316ea53]
- Updated dependencies [19d9910]
- Updated dependencies [19d9910]
- Updated dependencies [376a041]
- Updated dependencies [19d9910]
- Updated dependencies [316ea53]
- Updated dependencies [19d9910]
- Updated dependencies [ad11c38]
- Updated dependencies [bf41584]
- Updated dependencies [19d9910]
- Updated dependencies [376a041]
  - @repo/api@0.0.3
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
  - @repo/payments@0.0.3
  - @repo/search@0.0.3
  - @repo/weave-core@0.1.3
  - @repo/logs@0.0.1
  - @repo/mail@0.0.1
  - @repo/storage@0.0.1

## 0.0.3

### Patch Changes

- Updated dependencies [955634a]
  - @fabricorg/mcp-server@1.0.0

## 0.0.2

### Patch Changes

- Updated dependencies [2a6e543]
  - @repo/database@0.0.2
  - @repo/temporal@0.0.2
  - @repo/agent-core@0.1.2
  - @repo/ai@0.0.2
  - @repo/api@0.0.2
  - @repo/atlas@0.0.2
  - @repo/auth@0.0.2
  - @repo/connectors@0.0.2
  - @repo/integrations@0.0.2
  - @repo/mcp@0.0.3
  - @repo/payments@0.0.2
  - @repo/rag@0.0.2
  - @repo/search@0.0.2
  - @repo/weave-core@0.1.2

## 0.0.1

### Patch Changes

- 044a9f7: Stop the agent staleness sweep from marking non-probeable system agents as "Stale". `markStaleAgentsInactive` flipped any ACTIVE agent with a non-null `deploymentUrl` and a lapsed `lastHealthCheck` to STALE — but in-process `FABRIC_NATIVE` agents and inline agents (empty `deploymentUrl`) are no longer probed (#1685 follow-up), so their `lastHealthCheck` never refreshes and they were turned STALE instead of staying ACTIVE. The sweep now excludes them, a migration resets the rows already mislabeled, and the Agents page renders the `STALE` status with its own pill (previously it fell through to "Inactive"). Follow-up to #1685.
- 2ebbdb5: Fix a React hydration error (#418) that fired on every /app page. The Fabric Agent launcher derived its keyboard-shortcut label from `navigator.platform` during render, so the server rendered "Ctrl+J" while a macOS client rendered "⌘J" — a text mismatch on the always-present launcher. The label is now resolved through a hydration-safe `useShortcutLabel` hook that renders the neutral fallback on the server and the first client render, then upgrades to the platform-specific label after mount.
- 1e4363c: Fix project realtime (SSE) reconnect handling. The endpoint closes the stream at its ~5-minute max duration by design and expects a reconnect, but the client counted every such cycle against its 3-attempt cap and never reset it on a successful connection — so realtime silently disabled itself after ~15 minutes of a healthy session, and logged a "realtime features may be unavailable" warning on every routine drop. The reconnect budget is now reset on each successful open (the cap applies only to consecutive failures), and the unavailability warning fires only when the budget is genuinely exhausted.
- 5ad88a5: Fix System Agents falsely showing "Error" on the Agents page. The health monitor probed the raw stored `deploymentUrl` while the orchestrator probes a resolved URL (`resolveAgentUrl`), so reachable system agents were marked ERROR. The monitor activity and the manual "Check health" procedure now resolve the URL the same way; an agent only flips to ERROR after 3 consecutive failed probes (instead of one); and the probe-failure reason (resolved URL + cause) is persisted to `lastHealthError` and surfaced as a tooltip on the status pill. Fixes Bug #1685.
- 44f4496: Fix document highlight saving and dark mode legibility
- Updated dependencies [044a9f7]
- Updated dependencies [3d36eb3]
- Updated dependencies [be2bb59]
- Updated dependencies [a03d88d]
- Updated dependencies [f42cf1e]
- Updated dependencies [1a8fc05]
- Updated dependencies [6f8e223]
- Updated dependencies [5ad88a5]
  - @repo/database@0.0.1
  - @repo/temporal@0.0.1
  - @repo/api@0.0.1
  - @repo/ai@0.0.1
  - @repo/agent-core@0.1.1
  - @repo/auth@0.0.1
  - @repo/code-understanding@0.0.1
  - @repo/connectors@0.0.1
  - @repo/integrations@0.0.1
  - @repo/mcp@0.0.2
  - @repo/payments@0.0.1
  - @repo/rag@0.0.1
  - @repo/search@0.0.1
  - @repo/weave-core@0.1.1

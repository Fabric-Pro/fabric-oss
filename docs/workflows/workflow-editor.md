# Workflow Editor

How the Workflow Editor is put together, the limits it enforces, and what is
known to be missing.

- **Audience**: engineers working on the Workflow Editor, its API or its executor
- **Owner**: Fabric platform team

The editor is a React Flow canvas, a palette derived from the integration plugin
registry, and a Temporal-backed executor. Three companion documents cover
specific mechanics in depth: [Publishing & triggers](publishing-and-triggers.md),
[Node field validation](node-field-validation.md) and
[Temporal durability](temporal-durability.md). The scenarios that exercise all of
this, and what covers each one today, are in
[Workflow Editor test coverage](../qa/workflow-editor.md).

## How the pieces fit

| Layer | Where |
|---|---|
| Canvas, palette, config panels | `apps/web/modules/saas/workflows/components/` |
| Palette source of truth | `lib/node-definitions.ts`, derived from `lib/plugins/*` and `lib/system-nodes.ts` |
| API procedures | `packages/api/modules/workflows/` (`router.ts` is the surface) |
| Graph validation | `packages/api/modules/workflows/lib/workflow-validation.ts` |
| Execution | `packages/temporal/src/workflows/workflow-builder-execution.ts` |
| Schedules | `packages/temporal/src/schedules/workflow-builder-schedule.ts` |
| Webhook entry point | `apps/web/app/api/workflows/trigger/[workflowId]/route.ts` |

Two invariants underpin most scenarios below:

1. **Workflows are user-owned, including inside an organization.** Membership
   alone never grants access; every path resolves through `hasWorkflowAccess`.
2. **Scheduled and webhook runs execute their recorded published snapshot.**
   Manual editor runs can test the current draft. Saving a schedule draft does
   not change its live cadence; publishing activates it.

## Edit and run timestamps

`updatedAt` records workflow edits. `lastRunAt` records the latest accepted run's
start time. Execution state, failure counters and automatic pauses leave
`updatedAt` unchanged. The list footer shows `Last run` when `lastRunAt` exists;
a workflow without an accepted run shows `Edited`. Execution history holds the
individual run statuses and completion times.

Runtime settings and pause writes use `writeWorkflowRunState` in
[`workflows.ts`](../../packages/database/prisma/queries/workflows/workflows.ts).
Its caller holds the workflow row lock in the transaction and supplies the row's
organization context. The SQL update matches both the workflow ID and that
context, replaces settings, optionally changes status, and preserves the edit
timestamp. Use this helper for run-state writes that would otherwise trigger
Prisma's `@updatedAt` behavior.

The deployment seed `workflow-last-run-at-backfill` fills missing or older run
timestamps from execution history. It considers non-PENDING executions with a
Temporal identifier, plus SCHEDULE executions, whose creation path can leave
`temporalRunId` null. Each statement scans at most 500 workflows, commits
independently, and checks again before writing so it cannot replace a newer run
timestamp. It leaves `updatedAt` unchanged. The deployment runner records the
wrapper and implementation content hash after success and skips unchanged seeds.

The same implementation supports a dry run from `packages/database`, with the
database connection environment configured for the intended database:

```bash
pnpm exec tsx scripts/backfill-workflow-last-run-at.ts
```

Without `--apply`, it reports eligible rows without updating them. Use the normal
deployment seed for managed environments. The implementation is
[`backfill-workflow-last-run-at.ts`](../../packages/database/scripts/backfill-workflow-last-run-at.ts).

## Connection access

Integration connections are private to their owner by default, including existing
connections migrated without an explicit sharing decision. Credential format does
not determine access: personal OAuth grants, bot tokens, API keys and service
principals all require the same explicit choice.

In **Connections**, open a provider card (including Gmail) and use **Connection
access**. The controls work independently of workflow action plugins. An
organization owner or admin may share a connection they own after confirming that
all current organization members may use its account. The connection owner may
stop sharing even after losing their admin role; organization owners and admins
may revoke sharing of any shared connection. Publishing someone else's private
connection is forbidden. OAuth reconnect preserves the connection's sharing choice.

Execution selects the acting user's connection first, then an explicitly shared
connection in the same organization. Manual and API starts retain the triggering
user; schedules and webhooks retain the workflow owner. Runtime reads recheck
current membership. Stored connection IDs never fall back to another account when
access is removed. Databricks service principals and unattended channel bots should
be explicitly shared when organization members or inbound channel processing need
them; a bot-shaped token is not consent.

Public integration API approvals persist both the original requester and the
selected connection. Approval listing, approval and denial require current access
to the selected connection for both the caller and original requester. A teammate
may approve a shared connection; they cannot approve or inspect an owner-only grant. Replay
rechecks the original identity and connection rather than borrowing the approver's
account. Old approvals without that identity cannot execute and must be requested again. Revoking sharing, removing the requester
from the organization, disabling or deleting the connection blocks later replay.

## Measured limits worth knowing

**The execution concurrency cap is a soft bound, not a hard one.** The guard
counts a tenant's in-flight runs and then creates the row, and those two steps
are not in one transaction. Measured against the running app: with the cap at
25 and one slot free, twelve simultaneous starts let two through, peaking at 26
in flight. That is the intended shape of a runaway guard rather than a quota —
it exists so one tenant cannot grow without bound, and a one-or-two overshoot
does not defeat that. Tightening it would mean a serializable transaction on
the start path, which costs more than the overshoot does.

## Known gaps and open issues

Five remain open. Two need a product decision, one needs either a UI or a
retirement, and two are small gaps with the plumbing already in place. Items listed here earlier that are now fixed are recorded below so
the history is not lost.

1. **Published version is never what executes.** Every trigger path runs
   `workflow.nodes`; `WorkflowVersion` is history only. The webhook path
   compounds this by recording `version: publishedVersion ?? version`, so the
   execution record names a version that is not what ran. Either executions
   should load the published snapshot, or the `version` column should record
   the graph that ran. Today it does neither. This is a semantics decision
   about what "publish" promises, not a defect with an obvious fix.

2. **The trigger route's `GET` is unauthenticated**, returning workflow name,
   status, trigger type and published version to anyone holding the workflow
   id. That is the documented contract — it is published as a webhook health
   check with those exact fields — so narrowing it breaks callers. The id is an
   unguessable cuid, but it travels in webhook URLs pasted into third-party
   systems, so treat it as shared rather than secret. Worth a decision on
   whether the `name` field needs to be there.

3. **Workflow API keys cannot be created from the product.**
   `workflows.apiKeys.{create,list,revoke}` are wired into the router and the
   trigger route accepts the `wfk_` keys they issue, but nothing under
   `apps/web/modules/saas/workflows` calls them, so the only way to obtain a key
   is to call the procedure directly. Signature authentication covers the same
   ground and is fully reachable from the publish dialog, which is why the
   customer documentation describes that path and not this one. Either build the
   panel or retire the endpoints — leaving an advertised auth method with no way
   to obtain a credential is the worst of the three.

4. **Per-node `input` is never written.** `createWorkflowExecutionLog` accepts
   an `input` field and redacts it, `WorkflowExecutionLog.input` exists, and
   `ExecutionPanel` renders it — but the workflow never passes one, so the
   column is always null and the section never appears. Duration was the same
   shape and is now fixed; `input` was left alone deliberately. The obvious
   patch — passing `nodeInputs` — writes every earlier node's output into every
   node's row, which is quadratic in graph size and doubles the activity payload
   per node against a 200-node ceiling. If we want it, store the node's resolved
   config rather than its whole context.

5. **The run history shows neither the trigger nor a status filter.**
   `list-executions` accepts a status filter and the row carries `triggerType`,
   but `WorkflowRunHistory` renders neither. Cheap to add; the API is already
   there.

Fixed since: the webhook path now carries the run ceiling, the per-tenant
concurrency cap and the `workflow-builder` queue that the manual path always
had; and a run Temporal refuses is recorded `FAILED` with a reason instead of
being left `PENDING` forever. Webhook graph validation was deliberately not
added — a published workflow was validated at publish time, and re-validating
per request costs a graph walk on the hot path.

## Delivery starters and configuration checks

The welcome screen offers five delivery starters: delivery brief, notes to action
plan, release notes, decision digest and delivery risk review. Choosing one creates
an owned organization draft. It does not publish, schedule or run it. Run asks for
project notes; these become the trigger's `data.notes` input. No documents are
looked up automatically. The action-plan starter passes the summary to its next
step using a stable ID reference, `{{$draft.text}}`.

Names save on blur or Enter, separately from graph saves. The editor announces
saving, success or failure and retains a failed name for retry. Runs opens a
paginated history pane on demand. Select a run and a step to inspect its recorded
result; text and Markdown agent documents are formatted safely, with the exact
stored output available under Raw output. Copy uses the selected view. HTML is
inert and Markdown images are not fetched. Insert output offers upstream values
using stable step IDs; code fields continue to receive inputs separately.

Before publication, the dialog checks the saved graph, supported node schemas,
AI provider or eligible ChatGPT plan configuration, and accessible GitHub, Slack
and Linear connections. Other connectivity checks remain at runtime. The result
is informational: it does not live-test tokens, model availability, quotas or
external services and does not replace publication or execution authorization.
Refresh it after changing connections. Temporal remains the execution engine.

| Operation | REST API | SDK | CLI | MCP |
|---|---|---|---|---|
| List starters | `GET /api/v1/workflows/starters` | `workflows.listStarters` | `fabric workflows starters` | `fabric_list_workflow_starters` |
| Create a starter draft | `POST /api/v1/workflows/starters` | `workflows.createFromStarter` | `fabric workflows from-starter <starterId>` | `fabric_create_workflow_from_starter` |
| Check saved configuration | `GET /api/v1/workflows/:id/readiness` | `workflows.checkReadiness` | `fabric workflows check <id>` | `fabric_check_workflow_readiness` |

REST and CLI accept the usual organization selector. Reads require
`workflows:read`; draft creation requires `workflows:write`. Every transport also
checks the actor's current organization and object authority, including wildcard
credentials. These organization operations reject project-bound credentials; MCP also rejects
service credentials, which do not represent a current member. Starter creation is audited; creation is never automatically retried
by the SDK because it is not idempotent. Lifecycle actions share the authorized command layer across Portal, REST, SDK, CLI and MCP. Mutation requests are not automatically retried by the SDK.

| Operation | REST path under `/api/v1/workflows/:id` | SDK | CLI | MCP |
|---|---|---|---|---|
| Publish | `POST /publish` | `publish` | `workflows publish` | `fabric_publish_workflow` |
| Unpublish | `POST /unpublish` | `unpublish` | `workflows unpublish` | `fabric_unpublish_workflow` |
| Pause/resume future triggers | `POST /pause`, `POST /resume` | `pause`, `resume` | `workflows pause`, `workflows resume` | `fabric_pause_workflow`, `fabric_resume_workflow` |
| Restore a publication | `POST /rollback` | `rollback` | `workflows rollback <id> <version>` | `fabric_rollback_workflow` |
| List version metadata | `GET /versions` | `listVersions` | `workflows versions` | `fabric_list_workflow_versions` |
| Inspect live schedule | `GET /schedule` | `getSchedule` | `workflows schedule show` | `fabric_get_workflow_schedule` |
| Save schedule draft | `PUT /schedule` | `configureSchedule` | `workflows schedule set --cron <expression> --timezone <zone>` | `fabric_configure_workflow_schedule` |

Lifecycle mutations require `workflows:write`; reads require `workflows:read`, together with the creator’s current object permission. Publishing and restoring a publication commit the immutable version and publication pointer in one transaction. Concurrent edits return a conflict rather than losing a draft. Restoring a publication creates a new version and retains the workflow’s paused/draft state and live runtime settings, including frame identities and failure bookkeeping. The schedule dialog shows actual engine state, verifies normalized calendar cadence against the publication, displays the next run in the published time zone, and keeps draft changes separate. Unsupported calendar forms are explicitly unverified. Reopening waits for a fresh read. Webhook workflows cannot silently be converted to schedules; duplicate them for a separate scheduled workflow. Pause and resume affect future triggers; existing runs continue. Repeating pause or resume retries schedule synchronization without creating another version. If synchronization fails, inspect the schedule and use Retry synchronization after recovery.

## Saved result checks

In a completed run, select a text-producing step and choose **Check result**.
Add required or forbidden exact phrases, preview the checks, and save a passing
baseline. In a later run of that step, choose the saved check and compare it
with the original run. The comparison uses the same expectations for both
recorded answers and shows their execution versions and any regression.

Whitespace in exact phrases is preserved. Requests are bounded consistently at
128 KiB across the REST surface and the shared scoring contract.

These are deterministic recorded-output evaluations using the existing Fabric
context-quality scorer. They do not invoke a workflow, model, retrieval, or
external service, and they do not establish factual accuracy. The original
answers are loaded from authorized execution logs and are never truncated for
scoring. This operation does not export them to an evaluation destination.
Existing governed evaluation destinations and their Temporal processing remain
separate; cloud export and automatic evaluation of every scheduled run are not
supported by these result-check commands.

Checks are immutable, bounded workflow configuration (at most 20 per workflow,
128 KiB including other settings). Only expectations and baseline references
are stored; no answer is copied into the configuration. A namespaced collection
is tied to its workflow so duplication does not import another workflow’s
baselines. Check edits lock and re-read the settings row, preserving the latest
runtime state and the definition’s edit timestamp. An unsupported configuration
version fails closed with an upgrade/support message; it is never silently reset. General settings edits preserve the managed check collection and
reject attempts to write its reserved field. Rollback retains live settings and
therefore retains saved checks. Removing a check leaves its original run intact.

| Operation | REST path under `/api/v1/workflows/:id/checks` | SDK method | CLI under `fabric workflows checks` | MCP tool |
|---|---|---|---|---|
| Inspect result | `POST /inspect` | `inspectResult` | `inspect <id> <executionId> <nodeId>` | `fabric_inspect_workflow_result` |
| List checks | `GET /` | `listChecks` | `list <id>` | `fabric_list_workflow_checks` |
| Preview expectations | `POST /preview` | `previewCheck` | `preview <id> <executionId> <nodeId> --revision <sha256> --require <phrase>` | `fabric_preview_workflow_check` |
| Save passing baseline | `POST /save` | `saveCheck` | `save <id> <executionId> <nodeId> --revision <sha256> --name <name> --require <phrase>` | `fabric_save_workflow_check` |
| Compare a later result | `POST /apply` | `applyCheck` | `compare <id> <checkId> <executionId> --revision <sha256>` | `fabric_apply_workflow_check` |
| Remove check | `POST /remove` | `removeCheck` | `remove <id> <checkId> --revision <sha256>` | `fabric_remove_workflow_check` |

Read actions require `workflows:read`; saved-check mutations require both
`workflows:read` and `workflows:write`, since they derive information from private
run evidence. Every request also checks current owner and organization authority,
including wildcard keys. Project-linked workflows require current access to a
non-deleted project hosted in the organization; mutation requires project edit
permission. Organization-wide check operations reject project-bound credentials.
Mutation audits contain check identifiers, not answers or phrase content. Revision
pins refuse stale results or removed checks across all transports.

Workspace story-review configuration is an explicit apply operation for existing
published or paused bindings: it commits the validated graph as a new immutable
publication without changing activation state, then synchronizes only an active
schedule. Draft configuration remains a draft and performs no scheduling I/O.

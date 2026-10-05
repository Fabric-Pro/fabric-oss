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
2. **Triggers execute the current graph, not the published snapshot.**
   `WorkflowVersion` exists for history and rollback only.

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

# Workflow Editor test coverage

The end-to-end scenario catalogue for the Workflow Editor, and what each scenario is covered by today.

- **Audience**: engineers and QA working on the Workflow Editor; anyone deciding whether a change to it is adequately tested
- **Owner**: Fabric platform team

This page covers what must be tested and what covers it today. How the editor is
built, the limits it enforces and the gaps still open are in
[Workflow Editor](../workflows/workflow-editor.md); the mechanics of specific
areas are in [Publishing & triggers](../workflows/publishing-and-triggers.md),
[Node field validation](../workflows/node-field-validation.md) and
[Temporal durability](../workflows/temporal-durability.md).

## Scenario catalogue

Status values: **auto** (an automated test asserts it), **manual** (needs a
run-through against a deployed environment), **gap** (neither).

### WE-1 Workflow lifecycle (CRUD)

| # | Scenario | Expected | Status |
|---|---|---|---|
| 1.1 | Create workflow from the empty state | Lands in the editor, `DRAFT`, version 1 | manual |
| 1.2 | List reflects personal vs organization context | Personal listing pins `organizationId: null`; count uses the same filter as the page | auto |
| 1.3 | Rename / edit description | Persists across reload | manual |
| 1.4 | Duplicate | Fresh `DRAFT` owned by the caller; never inherits the source's published state or webhook secret | auto |
| 1.5 | Delete (card menu: Activate / Duplicate / Delete) | Row gone; any schedule removed | manual |
| 1.6 | Open a workflow belonging to another user in the same org | `NOT_FOUND` | auto |

### WE-2 Canvas editing

| # | Scenario | Expected | Status |
|---|---|---|---|
| 2.1 | Palette lists every action that has an executor | No action without a step binding is offered | auto |
| 2.2 | Every offered action has a matching executor and declared outputs | Three-way agreement holds | auto |
| 2.3 | Add a node, save, reload | Node survives the round trip | auto (Playwright) |
| 2.4 | Connect two nodes; delete an edge | Graph updates and persists | manual |
| 2.5 | Configure a node's fields | Values persist; defaults seeded from `configFields` | manual |
| 2.6 | Plugin brand icons carry accessible names | Icons are labelled | auto |
| 2.7 | Canvas fills the viewport height | Canvas is most of the window, at every breakpoint | auto (Playwright) |

### WE-3 Graph validation

| # | Scenario | Expected | Status |
|---|---|---|---|
| 3.1 | Empty graph | Refused: "Workflow has no nodes" | auto |
| 3.2 | Node count above `MAX_WORKFLOW_NODES` (200) | Refused with the limit named | auto |
| 3.3 | Node count above 75% of the cap | Warning, still valid | auto |
| 3.4 | Edge referencing a missing node | Refused | auto |
| 3.5 | Cycle in the graph | Refused, including a self-loop and a cycle no entry node reaches | auto |
| 3.6 | Condition node missing a true/false branch | Warning, not an error | auto |
| 3.7 | Placeholder nodes (`add`, `empty-action`) | Excluded from all counts | auto |
| 3.8 | Node reached by two paths (diamond) | Valid — not a false-positive cycle | auto |
| 3.9 | Node wired to nothing | Warning, not an error | auto |

### WE-3b Condition expressions

The evaluator is what decides which branch a run takes, so a wrong answer here
routes every run down one path silently rather than failing.

| # | Scenario | Expected | Status |
|---|---|---|---|
| 3b.1 | `{{Node.text}}.includes('x')` where the text contains `x` | `true` branch | auto |
| 3b.2 | Same expression where it does not | `false` branch | auto |
| 3b.3 | Node label containing spaces, any expression form | Reference resolves | auto |
| 3b.4 | Substring test against a missing node | `false`, no throw | auto |
| 3b.5 | Substring tests composed with `&&` / `||` | Evaluated per operand | auto |
| 3b.6 | Ordinary comparisons | Unchanged by the substring path | auto |

### WE-4 Manual execution

| # | Scenario | Expected | Status |
|---|---|---|---|
| 4.1 | Run a valid workflow | Execution row, `RUNNING`, per-node logs | manual |
| 4.2 | Run an invalid workflow | `BAD_REQUEST` before any execution row is created | auto |
| 4.3 | Run with unsaved canvas changes | The posted graph is what gets validated *and* executed | auto |
| 4.4 | Concurrency cap reached | `TOO_MANY_REQUESTS`, no execution row | auto |
| 4.5 | Cancel a running execution | Status `CANCELLED`, Temporal run cancelled | auto |
| 4.6 | Node fails | Execution `FAILED`, error surfaced on the node | manual |
| 4.7 | External-write node fails infrastructurally | Not retried (no duplicate side effect) | auto |
| 4.8 | Temporal unavailable or refuses the run | Execution recorded `FAILED` with a reason, not left `PENDING` | auto |

### WE-5 Publish, unpublish, rollback

| # | Scenario | Expected | Status |
|---|---|---|---|
| 5.1 | Publish a valid workflow | `PUBLISHED`, version incremented, snapshot written | manual |
| 5.2 | Publish a workflow that fails validation | `success: false` with issues; nothing published | auto |
| 5.3 | Publish with webhook enabled | URL + secret returned; secret stored encrypted, plaintext returned once | auto |
| 5.4 | Republish with webhook already enabled | Existing secret reused, not re-encrypted, decrypted for the response | auto |
| 5.13 | Publish without a webhook | Stored secret untouched, nothing echoed back | auto |
| 5.14 | Trigger type after publish | `WEBHOOK` when requested, `SCHEDULE` from a cron on the graph, webhook wins over a leftover cron | auto |
| 5.5 | Publish a graph carrying a Schedule trigger | Temporal Schedule created | auto |
| 5.6 | Unpublish | Back to `DRAFT`; schedule deleted | auto |
| 5.7 | Rollback to an earlier version | New version created from the target; graph restored | auto |
| 5.8 | Rollback re-syncs the schedule to the restored graph | Old cron stops firing | auto |
| 5.9 | Rollback of a `DRAFT` workflow | Schedule not made live | auto |
| 5.10 | Rollback to a version that does not exist | `NOT_FOUND`, nothing mutated | auto |
| 5.11 | Version row carries the parent's tenant columns | Visible under the `user_owned` RLS policy | auto |
| 5.12 | Non-owner org member attempts publish / unpublish / rollback | `NOT_FOUND`, nothing mutated | auto |

### WE-6 Triggers

Three trigger types are offered: manual, webhook and schedule. `EVENT` remains in
the Prisma enum for rows that already carry it, but it is no longer selectable —
nothing dispatched it, so a workflow created with it could only ever be run by
hand from the editor.

| # | Scenario | Expected | Status |
|---|---|---|---|
| 6.1 | Webhook with a valid API key | Execution starts | auto |
| 6.2 | Webhook with a valid HMAC signature | Execution starts | auto |
| 6.3 | Webhook with missing or bad credentials | 401, no execution row | auto |
| 6.4 | Webhook against an unpublished workflow | 403, no execution row | auto |
| 6.5 | Webhook against a workflow whose trigger is not `WEBHOOK` | 403, no execution row | auto |
| 6.6 | API key whose tenant disagrees with the workflow | Rejected | auto |
| 6.7 | Revoked or expired API key | Rejected | auto |
| 6.8 | Rate limit exceeded | 429 before the workflow is even read | auto |
| 6.13 | Webhook body that is not JSON | 400, no execution row | auto |
| 6.14 | Webhook when the tenant is at its concurrency cap | 429, no execution row | auto |
| 6.15 | Webhook dispatch target | `workflow-builder` queue, six-hour run ceiling | auto |
| 6.16 | Webhook when Temporal refuses the run | Execution `FAILED` with a reason, 502 | auto |
| 6.9 | Rate limiter unavailable in production | 503, fails closed | auto |
| 6.10 | Schedule fires | Kickoff creates the execution row; attributed to the workflow's tenant, `triggerType=SCHEDULE` | auto |
| 6.11 | Editing the cron on a published workflow | Schedule updated in place, history kept | auto |
| 6.12 | Schedule reconciliation repairs drift | Orphaned schedules removed | auto |
| 6.17 | Pausing or archiving a published workflow | Schedule taken down; cron stops firing | auto |
| 6.18 | Activating a paused workflow | Schedule restored | auto |

### WE-7 Integrations

| # | Scenario | Expected | Status |
|---|---|---|---|
| 7.1 | Connect an integration; credentials stored encrypted | Never returned in plaintext | manual |
| 7.2 | Test connection, saved and unsaved | Success/failure surfaced | manual |
| 7.3 | Delete an integration still bound to a node | Conflict reported | auto |
| 7.4 | Integration lookup is tenant-scoped | No cross-tenant read | auto |
| 7.5 | Every registered provider has an icon and settings surface | No unrendered provider | auto |

### WE-8 Tenancy and authorization

| # | Scenario | Expected | Status |
|---|---|---|---|
| 8.1 | Personal and organization workflows never mix | `getWorkflowById` pins `organizationId: null` for a personal read | auto |
| 8.2 | Org member cannot read another member's workflow | `hasWorkflowAccess` false — membership is necessary, never sufficient | auto |
| 8.3 | Org member cannot mutate another member's workflow | `NOT_FOUND` | auto |
| 8.4 | Execution logs inherit the parent's tenant | Child rows carry both columns; node input is redacted; one row per node | auto |
| 8.5 | Read-only mode blocks workflow writes | Write gate refuses | auto |

### WE-9 AI assistance

| # | Scenario | Expected | Status |
|---|---|---|---|
| 9.1 | Generate a workflow from a prompt | Valid graph, executable node types only | gap |
| 9.2 | Generate code from a graph | Deterministic output | auto |
| 9.3 | Generation returns an unknown node type | Rejected, naming the unsupported types | auto |

## What a browser pass still has to cover by hand

The `manual` rows above are the ones no suite asserts. The **cross-user tenancy**
rows need a second account in the same organization; plan for that before
starting, or the pass stops halfway.

### Executed against staging, 2026-08-08

A scripted browser pass drove `staging.fabric.pro` against one workflow, then
deleted it (delete 200, re-read 404). Nine rows passed: create from the list,
rename and persist, configure node fields, canvas renders the saved graph
(3 nodes / 2 edges), delete an edge, start a run, per-node logs (3 logs, 3 with
output), node failure surfaced (`Node http_2 failed: HTTP 404`), and AI
generation returning a graph.

The tenth found a defect. Asked to branch on a status code, the live generator
emitted `condition_1 -> condition_1` on both handles; the graph saved and every
run was refused with "Workflow contains a cycle". Fixed by dropping
self-referencing edges and telling the model a branch must target another node.

The same pass found a second one: a reference to an object interpolated as
`[object Object]`, which is the default shape of generated graphs
(`{{Trigger.data}}`).

Two things worth knowing for the next pass. Per-node `duration` read null on
staging because that fix had not deployed yet — it is a useful signal for
whether a deploy has landed. And a driver script must use `executionId` for
`workflows/executions/get`, not `id`; getting that wrong reports a 400 as if it
were the run's status.

Two integration rows remain genuinely manual, and deliberately so: connecting an
integration and using **Test Connection** both need a real vendor credential,
which does not belong in an automated pass or in a shared environment. Exercise
them by hand against a throwaway key.

When measuring layout, assert a bounding box rather than visibility. A
collapsed canvas is still visible, which is how a canvas pinned to 211px on a
900px viewport passed a `toBeVisible` check at every breakpoint.

## Running the tests

```bash
# API procedures, including the publish lifecycle
pnpm --filter @repo/api test --run modules/workflows

# Palette / plugin contracts and integration UI
pnpm --filter web test --run __tests__/workflows
pnpm --filter web test --run modules/saas/workflows

# Temporal execution, retries, schedules
pnpm --filter @repo/temporal test --run workflow-builder

# Browser pass (self-skips when the environment is unavailable)
pnpm --filter web e2e tests/workflow-builder.spec.ts
```

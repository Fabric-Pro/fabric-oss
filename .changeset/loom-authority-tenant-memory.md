---
"fabric-app": patch
---

Orchestrator authority check fails closed, tool memory and trajectories are tenant-scoped, and column automations actually run

Four findings from the same review of the orchestrator's runtime-authority and
learning paths. None needed a schema change; all were a missing condition.

**The authority check failed open.** Before each step the orchestrator asks
`checkStepAuthorityActivity` which external providers the step reaches and
whether the user has granted authority for them. When the step carried no
tool-to-config mapping, the activity derived the providers from the tenant's
enabled MCP configs — and if that lookup threw, it logged, kept an empty
provider list, and the very next line returned `allowed: true`. A database
hiccup at the wrong moment disabled the gate. The activity now returns a block
with a dedicated reason (`authority_check_failed`), and the workflow records it
as a step error rather than an approval prompt: there is nothing concrete to
ask the user to approve when the providers are unknown. The same activity also
classified a whole step by its *first* tool, so `[list_issues, delete_repo]` was
a READ step. The level is now the maximum across every tool in the step, and
`extractRequiredProviders` applies the same rule per provider instead of letting
the first tool seen win.

**Tool-usage memory was shared across tenants.** The orchestrator's learning
store keeps every tenant's past tool calls in one Qdrant collection. The payload
recorded `userId` and `organizationId`, but the two searches filtered only on
`type`, `toolId` and `success`, so argument suggestions for organization B were
built from organization A's past calls — their repository names, channel ids,
ticket keys. Both searches now carry the repo's XOR tenant filter: match the
organization, or match the user *and* require that the row has no organization
at all, so a user's personal context never sees what they did inside an
organization. Aggregated per-tool patterns for personal users used to share a
single `global` bucket; they are per-user now, and a pattern retrieved by id is
checked against the tenant before it is used. The execution-summary search in
`@repo/rag` gains the same "no organization" condition on its personal path.

**Trajectory replay ignored the organization.** `findSimilarTrajectory` looked
up completed trajectories by `userId` alone even though every row is written
with an `organizationId`, so a trajectory recorded in one organization could be
replayed in another whenever the task text matched. The lookup now uses the
strict XOR filter.

**Story-column automations never ran.** `fireColumnAutomations` started the
orchestrator on task queue `"orchestrator"`; the worker polls
`"fabric-orchestrator"`. Temporal accepted every workflow and nothing ever picked
it up. The queue name is now a shared constant (`ORCHESTRATOR_TASK_QUEUE`) used
by the worker, the interactive starter and the automation. The automation also
mirrors the interactive starter's contract — an `orch-<uuid>` execution id passed
in the input and used as the workflow id, plus a `userId` / `organizationId`
memo — so a step that pauses for approval can be found and answered through the
existing routes.

One related tightening rides along, behind a `patched()` gate so in-flight runs
replay unchanged: the "approve all" signal no longer satisfies a runtime-authority
checkpoint. Approve-all means "stop asking me about plan steps"; it should not
mint a live WRITE session for every connected provider off a single click.
Those checkpoints now wait for an explicit decision.

Review follow-ups in the same PR, all in the paths above:

- **The authority session is bound to the run.** When authority was missing,
  the activity looked for *any* active orchestrator session of the user and,
  finding one raised by an unrelated concurrent run, skipped creating this
  run's request and returned the block with no session id. The workflow then
  showed the step as ordinary step approval and executed it with no authority
  at all. The lookup is now keyed on the run (`findAuthoritySessionForRun`), an
  existing session is reused only when its grants cover the step, and the block
  always carries the session id. A session-less block fails the step, and after
  the user's decision the workflow re-runs the authority check before executing
  (both behind `patched()` gates).
- **Approve and deny are conditional transitions.** `approveAuthoritySession`
  updated by id alone after a separate read, so a revoke or deny that landed in
  between was overwritten. Both now transition inside one conditional update
  (owner, tenant, status, expiry); a retry of a committed approval succeeds,
  any other state raises `AuthoritySessionConflictError`, which the API maps to
  409 and the activity to a non-retryable failure.
- **Column automations fire only for a real lane change**, with a workflow id
  derived from the transition and `REJECT_DUPLICATE`, so a same-column reorder
  starts nothing and a duplicate delivery of one transition runs the skill once.
- **The orchestrator starter requires an organization.** It resolves one from
  the body or the session's active organization, verifies the caller's tie to
  it, and returns 403 with neither.

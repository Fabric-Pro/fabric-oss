---
"fabric-app": patch
---

Revoke a departing member's project access before the removal commits, and on the voluntary-leave path too

Leaving an organization did not take the departing person's access with it, in
two separate ways.

**The removal cascade could never run.** The code that started it lived in a
global `hooks.after` branch matching `/organization/remove-member`, and it
re-read the `member` row to discover which user had been removed. Better Auth's
handler calls `adapter.delete` on that row and only then returns
(`plugins/organization/adapter.mjs:218`), and `runAfterHooks` fires afterwards
(`api/dispatch.mjs:107`) — so the lookup returned null on every removal and the
start was skipped every time. A second, narrower bug sat on top of it: the
branch opened with `if (!organizationId) return;`, while Better Auth treats that
body field as optional and falls back to the session's active organization
(`crud-members.mjs:151`), so a removal issued from the active-org context also
skipped the seat update.

**Leaving fires no hook at all.** `/organization/leave` calls
`adapter.deleteMember` directly, and none of the plugin's fifteen
`organizationHooks` before/after pairs covers it. So a member who left kept
every `ProjectMember` row and every workspace membership row, and the
organization kept paying for the seat. There is no UI for this endpoint today,
but it is mounted and reachable by any authenticated caller.

Why the surviving rows matter more than they used to: `requireProjectPermission`
resolves a caller by walking personal-project owner, then active
`ProjectMember` row, then organization role. Membership of the organization is
the LAST rung, not a precondition — an accepted `ProjectMember` row authorizes
on its own, which is how a project-scoped guest belonging to no organization
works. Since `checkPublishingGenerationActor` began mirroring that ladder, such
a row is by itself enough to spend the organization's model budget.

The fix keeps the two halves of offboarding apart, and puts the revocation
where a failure can still refuse. `revokeOrganizationMemberAccess` in
`@repo/database` is idempotent and scoped to one organization on both sides of
every join. For a removal it runs from `organizationHooks.beforeRemoveMember`,
which Better Auth calls after all of its own checks and immediately before
`adapter.deleteMember`: throwing there leaves the member row in place, so there
is no state where somebody is out of the organization while their project
grants still authorize them — and the remove-then-re-add race disappears,
because nothing can be re-added before the row is gone. Seats move to
`afterRemoveMember`, since counting members before the deletion keeps paying for
someone on their way out.

The leave path revokes after the fact and contains its failures, because it has
to: `/organization/leave` has no before-hook, and a global `hooks.before` would
run ahead of Better Auth's own preconditions — the member row must exist, and
the only owner may not leave — so revoking there would strip a sole owner's
grants on an attempt that then fails. Replicating those preconditions would put
a second copy of Better Auth's policy in this repo, which is the class of defect
this change removes. That residual is stated in the code rather than hidden.

`memberCascadeDeleteWorkflow` is deliberately still unwired, and its header now
says so. It hard-deletes the departed member's projects, workspaces, workflows,
MCP configs, agent template instances and chats plus their stored attachments;
it has never executed; it has no fence against remove-then-re-add, so a member
restored before it ran would lose their fresh data; and its activities swallow
their own failures into an `errors[]` array, so Temporal never retries and the
run reports `success: false` to a caller that does not await it. Switching that
on is a first activation of destructive behaviour rather than a repair, and is
left as its own decision.

Not included, found while fixing: a voluntary departure produces no audit record
at all — `org.member.removed` is emitted only from `afterRemoveMember`, and
there is no `org.member.left` in `AUDIT_ACTIONS`.

Tests: 12 behavioural cases for the two offboarding halves (opposite failure
directions per path, empty-id refusal, seat containment), 6 predicate cases for
the revocation query (per-organization scoping, all three workspace membership
tables, summed counts), and 8 wiring cases pinning which hook each half is
wired to plus the absence of the post-delete member lookup. Seven negative
controls, each firing on exactly the intended cases; two of them found tests
that were passing for the wrong reason — an ordering assertion that counted
microtask ticks instead of draining a macrotask turn, and an unbounded source
slice that stayed green with the call moved into the wrong hook.

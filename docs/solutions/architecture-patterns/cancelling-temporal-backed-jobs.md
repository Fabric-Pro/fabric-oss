---
title: "Cancelling a Temporal-backed job: terminal-state guards, self-abort, and safe tenant gates"
date: 2026-07-02
category: docs/solutions/architecture-patterns
module: reports
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - Adding a user-facing Cancel/Stop control to a long-running Temporal (or any durable-workflow) job
  - Introducing a terminal status (CANCELLED) that must win against a concurrently-running worker
  - Writing a tenant-scoped cancel or mutation procedure over an unscoped id lookup
tags: [temporal, cancellation, race-condition, compare-and-set, terminal-state, tenant-isolation, idempotency, background-job]
---

# Cancelling a Temporal-backed job: terminal-state guards, self-abort, and safe tenant gates

## Context

Adding a Cancel button to a long-running job that runs as a Temporal workflow (report generation, an agentic loop, a scan) looks like "flip the DB row to CANCELLED and call `workflow.terminate()`." That naive version is wrong in four separate, non-obvious ways — each of which shipped as a bug in a first draft and was caught in review. This captures the patterns so the next cancel feature starts correct.

The reference precedent in this repo is the security-scan finding-grouping cancel (`packages/api/modules/projects/procedures/scan/cancel-grouping.ts` + `packages/temporal/src/workflows/security-finding-grouping.ts`). It is a good starting shape (start/get/cancel triple, DB-polled status, `terminate()` + procedure-owned DB flip) but relies on `terminate()` alone and reuses `FAILED` because its status enum has no `CANCELLED`. The report cancel (`packages/api/modules/reports/procedures/instances/cancel-execution.ts`) improved on all four points below.

## Guidance

### 1. Cancel needs a TWO-SIDED guard plus a self-abort — not just `terminate()`

`terminate()` is best-effort and, critically, **cannot kill an in-flight activity** — an activity already dispatched to a worker runs to completion; only *new* activity scheduling stops. So two races exist and both must be closed at the data layer, not by trusting `terminate()`:

- **Forward (cancel clobbers a completing run, or a completing run clobbers the cancel):** the workflow's own status writes and the cancel flip target the same row and can overwrite each other.
- **`terminate()` fails:** the DB says CANCELLED (user sees success) but the workflow keeps running and burning cost.

The three-part pattern:

1. **Cancel via a guarded compare-and-set flip** — only flip while the row is still active, so a run that already went terminal is never clobbered:

   ```ts
   // updateMany, not update — a zero count means "already terminal / lost race"
   const won = (await db.job.updateMany({
     where: { id, status: { in: ["PENDING", "RUNNING"] } },
     data: { status: "CANCELLED", cancelledBy, cancelledAt: now },
   })).count === 1;
   if (!won) return { cancelled: false }; // caller shows the real outcome, not an error
   ```

2. **Route ALL the workflow's own status writes through a "CANCELLED wins once set" guard** so a completing run can't overwrite the cancel:

   ```ts
   // updateMany WHERE status != CANCELLED; returns whether the write landed
   const written = (await db.job.updateMany({
     where: { id, status: { not: "CANCELLED" } },
     data: { status, /* ... */ },
   })).count === 1;
   return written;
   ```

3. **Self-abort:** because `terminate()` may fail, have the workflow **check that guard's boolean at its first status write** and abort *before* the expensive pipeline:

   ```ts
   const started = await updateStatus({ status: "RUNNING", ... }); // returns `written`
   if (!started) {
     // a user cancel already flipped the row; terminate() may not have reached us
     return { status: "CANCELLED", artifacts: [], duration: Date.now() - startTime };
   }
   ```

   This is the only backstop that stops token/compute spend when `terminate()` fails. It is deterministic (an activity result recorded in history), so it is replay-safe.

### 2. A guard on the job row does NOT cover sibling tables

The status guard protects the *execution/status row*. It does nothing for a **different table** a late activity writes — e.g. an in-flight `storeInstanceArtifact` persists an artifact row for a run that was cancelled a moment earlier. When you add a "terminal state wins" guard, enumerate every table a late activity can still write, and close each:

- **Read path:** the UI/query suppresses the sibling rows for the terminal state (e.g. hide artifacts when `status === "CANCELLED"`). This is the reliable user-facing guarantee.
- **Cancel path:** best-effort cleanup of the sibling rows after the flip (delete artifacts for the execution). Combined with the read-path suppression, a stray post-cancel insert never surfaces.

### 3. Tenant-scoped cancel over an unscoped lookup: gate BEFORE authz, and don't leak existence

Two traps here:

- **Order:** if the id lookup is unscoped (`findUnique({ where: { id } })`), the *tenant gate is the isolation boundary* and must run **before** any owner/role check. "Mirror the grouping precedent" is misleading when that precedent's lookup is tenant-scoped at the query level (`findFirst({ where: { id, projectId } })`) — copying its structure silently drops the scoping.
- **Existence oracle:** checking membership with a helper that throws `FORBIDDEN` for non-members, *after* a tenant-equality gate, leaks existence — an outsider who guesses the right org id gets `FORBIDDEN` (it exists here) vs `NOT_FOUND` (it doesn't). Resolve membership explicitly and return `NOT_FOUND` for non-members; reserve `FORBIDDEN` for members who lack the role.

  ```ts
  if (row.userId !== user.id) {
    const membership = row.organizationId
      ? await getOrganizationMembership(row.organizationId, user.id)
      : null;
    if (!membership) throw new ORPCError("NOT_FOUND", { ... });      // outsider — no leak
    if (membership.role !== "admin" && membership.role !== "owner")
      throw new ORPCError("FORBIDDEN", { ... });                     // member, wrong role
  }
  ```

### 4. Observability + audit

`terminate()` failure is where a stuck-after-cancel run hides. Log it through the structured logger with `executionId`/`workflowId` context (not `console.error`) so it's discoverable. Record the cancelling actor (`cancelledBy`) distinctly from the run's owner when an admin can cancel someone else's run — the owner field is not enough.

## Why This Matters

The whole point of a Cancel button on a long AI/compute job is to stop runaway cost. If it rests on `terminate()` alone, a single `terminate()` failure means the user sees "Cancelled" while the job keeps spending — the feature silently fails at exactly its job. The status-clobber races additionally let a cancelled run flip back to Completed (or surface a partial artifact), breaking the "no output for a cancelled run" contract. And an unscoped-lookup cancel is a cross-tenant IDOR waiting to happen. None of these are visible in the happy-path demo; all are load-bearing.

## When to Apply

- Any user-triggered cancel/stop on a Temporal or other durable-workflow job.
- Any time you add a terminal status that a concurrently-running worker must not overwrite — the compare-and-set + "terminal wins" guard generalizes beyond cancel.
- Any tenant-scoped mutation whose entity is fetched by an unscoped id (report executions/instances are user/organization-scoped, not project-scoped).

## Examples

Before (naive — three latent bugs):

```ts
await db.job.update({ where: { id }, data: { status: "CANCELLED" } }); // unconditional
await client.workflow.getHandle(workflowId).terminate();               // best-effort, unchecked
return { cancelled: true };
// workflow keeps its own unconditional COMPLETED write → clobbers CANCELLED
// workflow has no idea it was cancelled → runs the whole pipeline if terminate() failed
```

After (the pattern): guarded CAS flip → best-effort terminate → workflow's status writes are `!= CANCELLED`-guarded and return a boolean → workflow self-aborts at the RUNNING write when that boolean is false → sibling artifact rows suppressed in the read path and cleaned on cancel → tenant gate before authz with `NOT_FOUND` for non-members.

Tested at three layers: the compare-and-set/guard query helpers (real-Postgres behavior), the procedure orchestration (tenant gate, authz, race no-op), and a workflow-level test that mocks `@temporalio/workflow` so activities are `vi.fn()` stubs and asserts the self-abort skips the pipeline.

## Related

- Precedent: `packages/api/modules/projects/procedures/scan/cancel-grouping.ts`, `packages/temporal/src/workflows/security-finding-grouping.ts`
- Implementation: `packages/api/modules/reports/procedures/instances/cancel-execution.ts`, `packages/database/prisma/queries/reports.ts` (`cancelActiveTemplateInstanceExecution`, `finalizeTemplateInstanceExecutionStatus`), `packages/temporal/src/workflows/template-instance-execution.ts`

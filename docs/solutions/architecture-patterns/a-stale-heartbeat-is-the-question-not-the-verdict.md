---
title: "A stale heartbeat is the question; the orchestrator's answer is the verdict"
date: 2026-09-25
category: architecture-patterns
module: glossy-editions temporal build claims
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - "A database row claims exclusive ownership of a background run, and a crashed or timed-out run can leave the claim held forever"
  - "Choosing when a new request may take over a claim whose holder stopped writing heartbeats"
  - "Asking Temporal (or any orchestrator) whether a run is alive from inside a request path"
  - "Several transactions (finalize, fail, reclaim) change both an attempt row and its parent row"
tags: [temporal, heartbeat, claim, reclaim, liveness, lock-order, deadlock, fizzy-2589]
related_components: [temporal, database, api]
audience: Engineers building a claimed background job that must recover from a run that died without saying so
owner: Fabric platform
---

# A stale heartbeat is the question; the orchestrator's answer is the verdict

## Context

A Glossy edition build is a **claimed attempt**. The claim moves `GlossyEdition.currentBuildId` to a new attempt and inserts its `GlossyBuild` row as `BUILDING`, in one transaction. Every later write by the run is guarded on that attempt id. Guarding on identity rather than status is covered in the terminal-status learning listed under Related, and is not repeated here.

The open problem was recovery. A run can leave its attempt `BUILDING` without ever recording a failure. The workflow has a 30-minute execution timeout, and **a timed-out workflow runs no more code**, so its `catch` never writes `FAILED`. The claim then blocks every future build of that document. Something outside the dead run has to take over, and the hard part is telling a dead run from a slow one.

## Guidance

### 1. Use two conditions: a stale heartbeat AND the orchestrator saying the run is closed

Either condition alone takes over live runs:

- **Heartbeat alone** is not evidence of death. Time a run spends waiting for one of the worker's slots writes nothing, and a long model call writes nothing until the next activity starts. With a heartbeat-only rule, a queue backlog turns into stolen builds.
- **The orchestrator alone** is wrong in the other direction. Right after the claim commits, the workflow start is still in flight. Temporal has never heard of the run and answers `WorkflowNotFoundError`, which looks exactly like "gone". The fresh heartbeat written by the claim is what protects this window.

So staleness only raises the question, and Temporal's answer decides it (`isGlossyHolderGone` in `packages/api/modules/projects/lib/dispatch-glossy-build.ts`):

```typescript
if (!isGlossyHeartbeatStale(holder.heartbeatAt, now)) {
	return false;                                   // not even worth asking
}
return (await glossyRunLiveness(holder.workflowId)) === "gone";
```

### 2. Derive the stale threshold from the retry budget, below the execution timeout

The threshold is a number that has to be justified. `heartbeatAt` is written at claim time and whenever a build activity starts. The longest silence is one model-call activity going through all its attempts: 3 × 5-minute start-to-close, plus 5 s and 10 s of backoff, which comes to 15 min 15 s. **20 minutes** clears that with margin. It is also below the **30-minute** execution timeout, so a run that timed out is taken over at most 20 minutes after its last write.

If the proxy options in the workflow change, this number has to be recomputed. The comment on `GLOSSY_BUILD_STALE_AFTER_MS` shows the arithmetic so the next person can redo it.

### 3. The liveness answer has three states, and only `gone` releases the claim

```typescript
export type GlossyRunLiveness = "running" | "gone" | "unknown";
```

- **Closed means an allowlist, not "anything that isn't RUNNING".** `COMPLETED`, `FAILED`, `CANCELLED`, `TERMINATED`, `CONTINUED_AS_NEW` and `TIMED_OUT` count as gone. `RUNNING` **and `PAUSED`** count as live, because a paused run still holds its attempt. Any status that isn't named, including one a future Temporal version adds, is `unknown`, and the claim stays where it is.
- **`WorkflowNotFoundError` is `gone`, and any other error is `unknown`.** A connection failure is not evidence that the run is dead.
- **Put a time limit on the question.** Liveness runs inside the `get` and `build` request paths, and a Temporal server that accepts the connection but never replies would otherwise hang the request. After 5 s the answer is `unknown`, which keeps the claim. The cost of that is a stuck build for a little longer. The alternative is two builds of one edition.

### 4. Re-check the heartbeat under the row lock, and lock in one order

The reclaim is a check followed by an action, so it has to be re-checked where the action happens. `claimGlossyBuild` with `reclaim` first retires the holder with a conditional update, `WHERE status = 'BUILDING' AND heartbeatAt < staleBefore`, which locks the holder's row. A late heartbeat from the holder then either:

- commits first, so the retire matches nothing and the reclaim fails, which is correct because the holder is alive; or
- waits for the lock, and afterwards finds its attempt `SUPERSEDED`.

Every transaction that changes an attempt row and its edition row (finalize, fail, reclaim) **locks the attempt row first and the edition second**. Prisma has no `FOR UPDATE`, so finalize and fail take the attempt lock with a raw `SELECT ... FOR UPDATE`. Reclaim gets it from the conditional update. With one order there can be no deadlock between them. A cache write that holds the attempt row `FOR SHARE` either commits before such a transaction changes anything, or re-checks after it commits.

### 5. A failed start releases the claim through the same guarded write

When `workflow.start` throws, the dispatcher releases the claim through the guarded fail write (`WORKFLOW_START_FAILED`), so a retry can claim again. This is safe even when the start actually registered and only the reply was lost: the orphaned run's first guarded write finds its attempt no longer `BUILDING` and stops as superseded.

## Why This Matters

A claim with no recovery path turns a single timeout into a permanent "already building" for that document, and the only fix is to edit the database by hand. A recovery path that is too eager is worse: it runs two builds, both writing the same edition and the same cache rows. Each of the two conditions on its own leans one way or the other. Combining them, with an explicit `unknown` that keeps the claim, is what makes the takeover conservative without making it impossible.

## When to Apply

- Any "one run at a time per record" job built on a database claim plus a Temporal workflow.
- Any read path that turns a stuck claim into a user-visible state (for example, a `get` that shows "build failed" for a run that has gone). It must use the same `isGone` test as the reclaim, or the UI will offer a retry that the reclaim then refuses.
- Any new transaction that touches both the attempt and its parent. Follow the existing lock order.

## Examples

The decision table the tests cover:

| Heartbeat | Temporal says | Outcome |
|---|---|---|
| fresh | (not asked) | claim kept; the caller reads "already building" |
| stale | `RUNNING` / `PAUSED` | claim kept |
| stale | `TIMED_OUT` / `TERMINATED` / ... | reclaimed; the holder is marked `SUPERSEDED` |
| stale | not found | reclaimed |
| stale | timeout / connection error / unnamed status | claim kept (`unknown`) |
| stale at read, fresh at retire | n/a | reclaim fails; the holder keeps its attempt |

## Related

- `docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md`: guarding on attempt identity rather than status, and guarded writes that return `applied` / `superseded` instead of a count.
- `docs/solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md`: heartbeating long model calls inside Temporal activities.
- `docs/features/glossy-editions.md`: the build workflow, its task queue and rollout.

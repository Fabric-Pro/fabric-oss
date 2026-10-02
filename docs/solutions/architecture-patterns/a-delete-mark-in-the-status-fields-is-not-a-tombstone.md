---
title: "A delete mark in the status fields is not a tombstone"
date: 2026-10-01
category: architecture-patterns
module: company context deletion (packages/api company-context, packages/database queries, packages/temporal url-source)
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "A delete must take a row out of use at once, but a durable workflow removes the row and its external data later"
  - "Other writers (ingestion, embedding, crawl finalize, re-process) update the same row's status fields"
  - "A request starts a Temporal workflow and must decide what to do when the start fails or times out"
  - "External data (vectors, files) is cleaned up after the rows that name it are deleted"
tags: [tombstone, soft-delete, claim, compare-and-set, temporal, workflow-id, idempotency, qdrant, cleanup, fizzy-2719]
related_components: [temporal, api, rag]
---

# A delete mark in the status fields is not a tombstone

## Context

Deleting a company context source (Fizzy #2719) is durable: the API marks the source, then starts a Temporal workflow that removes the refresh schedule, the vectors, the stored file and finally the row. The mark has to take the source out of retrieval and out of every other flow the moment the delete is accepted.

The first version wrote the mark into the fields every other writer also writes: `extractionStatus: "FAILED"` plus a "being deleted" `extractionError`. Four rounds of adversarial review then found the same hole from different sides:

- The re-process claim treated `FAILED` as idle and claimed the source while it was being deleted.
- A second delete matched the same `FAILED` row and started a second deletion workflow (the id carried `Date.now()`).
- A late embed's `markEmbedded` / `setStatus("COMPLETED")` flipped the row back to ready.
- `process-file` and re-sync checked the mark on a row they had loaded earlier, then wrote `EXTRACTING` / `PENDING` unconditionally.
- A start that timed out after Temporal accepted it was "rolled back" by clearing the mark while the deletion was already removing data.

## Guidance

**1. Give the tombstone its own column, written only by the delete path.** A mark that shares fields with ordinary status writes is erased by the next ordinary status write. A dedicated column is not:

```prisma
model CompanyContextSource {
  // ...
  deletingAt DateTime? // set only by delete; never cleared by a status write
}
```

**2. Every write that starts work is an atomic conditional claim on the tombstone, not a check followed by a write.** Load-then-check-then-write loses to a delete that lands in between:

```ts
// Before: the check reads a row loaded earlier, the write is unconditional.
if (source.deletingAt) throw conflict();
await db.companyContextSource.update({ where: { id }, data: { extractionStatus: "EXTRACTING" } });

// After: one conditional write is the source of truth.
const { count } = await db.companyContextSource.updateMany({
  where: { id, organizationId, deletingAt: null, extractionStatus: "PENDING" },
  data: { extractionStatus: "EXTRACTING" },
});
if (count === 0) {
  const current = await getCompanyContextSourceMeta(id, organizationId);
  throw current?.deletingAt ? beingDeleted() : changedMeanwhile();
}
```

Apply the same guard to readiness (`companyContextReadyWhere` includes `deletingAt: null`) and to late completion writes (`markEmbedded`, a `COMPLETED` status write, crawl finalize). A refused late write takes the existing "source gone while embedding" path and removes the vectors it wrote. Failure-path status writes in work-starting procedures are conditional on `deletingAt: null` too.

**3. Make the deletion workflow id deterministic, and never answer success on the tombstone alone.** With `company-context-deletion-${sourceId}`, Temporal keeps one execution per source and "already started" means a deletion is running. Every path, including the delete that lost the tombstone race and the repeat delete of an already-tombstoned source, starts that id before answering:

```ts
async function startDeletionKeepingTombstone(deletion) {
  try {
    await startCompanyContextDeletion(deletion); // AlreadyStarted => success
  } catch (error) {
    // Never clear the tombstone here: the start may have reached Temporal
    // and timed out on the way back, so the deletion may already be running.
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to start deleting the source. Delete it again to retry.",
    });
  }
}
```

**4. Drive external cleanup from live rows, not from a list of deleted ids.** The company URL-page prune deleted page rows, then deleted the vectors of "late orphans" by id. When that second delete failed, the ids were gone with the rows and nothing could find the vectors again. The fix is a filter delete computed from the rows that still exist. It runs on every prune, so the next run removes whatever an earlier run left:

```ts
// Delete every page point of this source whose page row no longer exists.
const livePageIds = (
  await companyLinkCrawlStore(owner).listPages(parentContextId)
).map((page) => page.id);
await deleteCompanyPagePointsNotIn({
  organizationId,
  sourceId: parentContextId,
  livePageIds,
});
```

As defense in depth, retrieval drops page hits whose page row is gone or not embedded under the current model, using one org-scoped query.

## Why This Matters

A soft-delete mark is a lock that every other writer must respect. Kept in shared status fields, it is only as strong as the weakest writer, and every new writer (a re-process path, a retry, a late activity) silently weakens it. Each of the five findings above was a different writer. A dedicated column plus conditional claims turns "every writer must remember the delete" into "no writer can start work on a tombstoned row".

The ambiguous-start rule matters because Temporal client calls can succeed server-side and fail client-side. Rolling back on any error assumes the start did not happen, and for a deletion that assumption loses data mid-flight. Keeping the tombstone costs only a repeat click; the user wanted the source deleted anyway.

Live-row-driven cleanup turns a best-effort activity into a self-healing one without durable bookkeeping and without changing workflow code, which keeps the change replay-safe.

## When to Apply

- Any "mark now, delete durably later" flow over a row that other processes update.
- Any procedure or activity that moves a row into an in-flight state: claim it with a conditional `updateMany` on the tombstone (and the expected prior state), and act only on `count > 0`.
- Any request that starts a workflow whose effects are hard to undo: use a deterministic id, treat "already started" as success, and do not undo local state on an unknown outcome.
- Any cleanup of external stores (Qdrant, S3) that runs after the rows naming the data are deleted.

## Examples

- Delete: `packages/api/modules/organizations/procedures/company-context/delete.ts`
- Claims: `claimCompanyContextSourceForReprocess`, `claimCompanyFileSourceForProcessing`, `claimCompanyLinkSourceCrawl`, `releaseCompanyContextSourceClaim` in `packages/database/prisma/queries/company-context.ts`
- Readiness with the tombstone: `companyContextReadyWhere` (same file). It also pairs `urlPages: { every }` with `none`/`some`, because `every` is vacuously true when no page qualifies, and a website with zero indexed pages otherwise read as ready.
- Live-row sweep: `deleteCompanyPagePointsNotIn` in `packages/rag/lib/company-contexts/store.ts`, called from `packages/temporal/src/activities/url-source/prune-orphan-url-pages-activity.ts`
- Retrieval live-page filter: `keepLivePageHits` in `packages/temporal/src/lib/company-context-retrieval.ts`

Related: [a-stale-heartbeat-is-the-question-not-the-verdict.md](a-stale-heartbeat-is-the-question-not-the-verdict.md) (claim liveness), [a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md](a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md) (status guards vs retries), [cancelling-temporal-backed-jobs.md](cancelling-temporal-backed-jobs.md).

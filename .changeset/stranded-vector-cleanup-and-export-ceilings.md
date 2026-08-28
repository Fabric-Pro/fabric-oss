---
"fabric-app": patch
---

Unlink no longer strands conversation vectors when the store refuses, and the batch export stops allocating before it refuses for size

Fizzy #2228, three review findings on the download-all/conversation-capture
branch.

**A failed vector delete stranded points no retry could find.**
`deleteMonitoredConversationContext` deletes the pointer context row and its
cascaded bundles BEFORE their vectors — deliberately, because row absence is the
state a concurrent embedder reads to decide whether to abandon its write or
compensate for it. The consequence was that when Qdrant refused, the ids the
delete needed were already gone with the rows: the user's retry matched no
context row, took the `contextIds.length === 0` early return, and reported
SUCCESS while the conversation text stayed indexed forever. The Qdrant payload
carries the message text, so that was retained third-party conversation content
after the user had been told it was removed — and the unlink procedures' own doc
comments promise "a failure they can retry", which that control flow could not
keep.

The ordering stays; the IDS were made to survive it. New table
`project_context_pending_vector_cleanup` (migration `20260826130000`) holds the
project, the tenant under the same XOR CHECK the two capture tables carry, and
the id list. It is written in the SAME transaction as `projectContext.deleteMany`,
so the ids can never be lost with the rows, and cleared only once the vector
store confirms. Deliberately not a child of `project_context` — outliving those
rows is the point — and with no generated `ownerKey`, since it references no
context row for a composite key to compare against. Registered in
`src/tenant-db.ts` (`USER_OWNED_TABLES` + `PROJECT_SCOPED_TABLES`) and in the
`apply-rls-direct.ts` allowlist as `user_owned`; both registrations are enforced
by the existing `rls-coverage` guard.

Two drains, sharing one `drainPendingVectorCleanup`:
`deleteMonitoredConversationContext` drains its project's records BEFORE its own
early return, so a plain retry of the same unlink finishes the job; and the
scheduled `conversation-bundle-embedding-sweep` drains the queue across tenants
so cleanup completes when nobody retries. The sweep keeps its bounded batch, never
throws for one bad record, and never DROPS a record whose drain failed — it raises
`attempts` instead, which is also the sweep's queue order, so one record the
store keeps refusing cannot starve the rest. Every drain resolves the collection
from the record's own `organizationId`; a run-wide tenant would aim at a
collection the points are not in and look like a clean pass.

`deleteMonitoredConversationContext` now takes `userId` — the tenant a personal
record is written under — passed by all three unlink procedures.

**The batch export's size ceiling ran after the memory it guards.**
`create-contexts-batch-download-url` weighed the project only once
`assembleCrawledLinks` and `assembleCapturedConversations` had materialised every
crawled link's markdown and every monitored channel's transcript, so a project
that must be REFUSED for size allocated all of it first. The estimate is now
accumulated: rows carrying their own text are weighed with no query at all, and
each assembly adds its bytes inside the bounded fan-out and abandons the rest the
moment the running total crosses `MAX_BATCH_DOWNLOAD_BYTES`. Same `too_large`
`ORPCError`, same `reason`/data shape, so client handling is unchanged.

**A build that died mid-stream orphaned its uploaded archive.** The upload runs
concurrently with the archive writes by necessity, so the `fatalError` branch
threw over an object already sitting under `downloads/project-contexts/…` that
nobody would ever be handed a URL for. That prefix's expiry rule is applied by
hand per environment and may not be live, and since this branch the object can
hold captured conversation text. It is now deleted best-effort via `deleteObjects`
before the rethrow, with only the cleanup's own failure swallowed and logged, so
the reason the export failed is still what the caller sees.

Tests: 8 added to `packages/temporal/__tests__/conversation-bundle-capture.test.ts`
(a refused delete queues the ids; the retry drains them and succeeds; the sweep
drains unattended; a clean unlink queues nothing; the record is tenant-scoped in
both directions), 4 to
`packages/database/__tests__/conversation-capture-constraints.test.ts` (real
Postgres: the XOR CHECK, and that the record survives its context rows but not its
project), and 3 to the batch-download suite (assemblies stop early — asserted on
the query count, not just the error; the orphan is deleted; a failing cleanup does
not mask the build's error). Every one was confirmed non-vacuous by breaking the
behaviour it covers.

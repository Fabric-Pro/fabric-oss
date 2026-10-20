---
title: "A live generation run's write guard belongs to the row, not to the rollout flag"
date: 2026-10-20
category: architecture-patterns
module: project-documents generation
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - "A background run owns a record's body for minutes and outside writers (API, agents, UI, scheduled jobs) can also write it"
  - "The run saves its body at the same version it started from and bumps the version in a later step"
  - "A protection is introduced behind a per-organization rollout flag"
  - "A status value is set by a subsystem together with fields a watchdog relies on"
  - "An editor acknowledges an asynchronous save while the person keeps typing"
tags: [optimistic-concurrency, compare-and-swap, generation-run, rollout-flag, write-path-fan-in, collaborative-room, yjs, fizzy-2946]
---

# A live generation run's write guard belongs to the row, not to the rollout flag

## Context

A regenerated Proposal "flashed back" to its previous version in production
(Fizzy #2946). Fixing the editor exposed a wider gap: while a generation run
owns a document's body, every outside writer can overwrite it. The run saves
its body at the version it started from and bumps the version in a separate
step, so a writer guarded by version alone cannot see that a run wrote.

Six rounds of an adversarial review then found the writers one at a time:
the agent and v1 API writes, a status-only PATCH that ended the run first, a
version restore, a rejected regeneration and its fallback save, a manually
accepted refresh proposal, the scheduled refresh activity, and a client that
created a document directly in `GENERATING`. Each fix added the guard to one
more writer, until the guard itself was the problem: it was decided by the
`PROPOSAL_ARTIFACT` rollout flag, which can be turned off while a run keeps
writing.

## Guidance

1. **Decide the guard by persisted state.** "This document type, while its
   status is `QUEUED` or `GENERATING`" is a property of the row. A rollout
   flag decides what people see (prompt catalog, previews, the base a save
   must name); it must not decide whether data is protected, because a run
   started under the flag outlives a flag change. One pure predicate
   (`isRunGuardedDocumentType` in `@repo/utils/generation-run-guard`) is
   shared by the API, the MCP gateway and the Temporal worker.
2. **Refuse at the read, then again in the write's condition.** Each guarded
   writer refuses with `DOCUMENT_GENERATION_IN_PROGRESS` when it reads a live
   status, and passes `refuseWhileGenerating` so `updateDocument` adds
   `status NOT IN (QUEUED, GENERATING)` to its atomic `UPDATE ... WHERE`. A
   run queued between the read and the write is still refused.
3. **Guard on the body, not only the version.** A writer that read the body
   names `{expectedVersion, expectedContentHash}`; the hash catches a run's
   body saved at the same version. A scheduled job that applies itself takes
   the hash before its model call.
4. **Status values a subsystem owns are not client-writable.** `QUEUED` and
   `GENERATING` are written by dispatch together with the workflow id and
   start time the stale-run watchdog needs. If a client can send them, a
   status-only guard becomes a lever that strands the row forever.
   `isGenerationOwnedStatus` refuses them on every create and update
   (`DOCUMENT_STATUS_GENERATION_OWNED`); they still work as list filters.
5. **Inventory the writers when you add the guard**, not after a review finds
   them: grep every call of the write helper and every direct
   `projectDocument.update`, and classify each as guarded, run-owned (the
   run's own writes, scoped by its run identity) or out of scope.

The collaborative editor needed the same discipline on the client:

- **A save's answer confirms only what it sent.** Baseline the submitted
  snapshot (markdown and text captured in `onMutate`), never the live
  editor, or typing done during the flight reads as saved and the leave
  flush skips it.
- **State that must survive a sync-loss remount lives above it.** The inner
  editor unmounts when the room drops; per-mount dirty counters restart
  clean. A lifted "typed since save" flag restores the dirty state and the
  autosave on remount.
- **Save on leave from a layout-effect cleanup.** It runs before the room
  hook's passive cleanup destroys the Y.Doc and provider; save answers that
  arrive after the editor is gone must not serialize it.
- **A room seeded only when empty is never reconciled.** Stamp the room with
  `{version, contentHash}` of the saved body it descends from, converge a
  stale room through one claimed applier, and offer replaced unsaved text
  back once. TipTap's Collaboration binds the `"default"` fragment; checking
  `"prosemirror"` for emptiness re-seeds a full room.

## Why This Matters

Each writer fixed in isolation left the next one open, and the review found
them one per round. Tying the guard to a mutable flag silently reopened all
of them at once on a rollback. A guard keyed to the row, enforced in the
write's own condition and shared through one predicate, closes the class
instead of the instance. The generated body is the most expensive content in
the product (minutes of model time and a person's review), and an overwrite
is only visible in version history, if at all.

## When to Apply

- Adding any writer of a document body or status (API route, MCP tool,
  procedure, Temporal activity, scheduled job).
- Introducing a new long-running producer that writes a record in place.
- Putting a data-integrity rule behind a feature flag: split the rule (row
  state) from the experience (flag).

## Examples

Before: the refusal followed the flag, and the scheduled refresh named only
the version it read.

```ts
const guarded = await isProposalClientDocument({ organizationId, documentType });
await updateDocument(id, { content }, { expectedVersion });
```

After: the refusal follows the row, and the write names the body too.

```ts
const guarded = isRunGuardedDocumentType(document.type);
if (guarded && (document.status === "QUEUED" || document.status === "GENERATING")) {
	return propose(); // keep the result, write nothing
}
await updateDocument(id, { content }, {
	expectedVersion,
	expectedContentHash: baselineContentHash,
	refuseWhileGenerating: guarded,
});
```

## Related

- [A write that splices from an earlier read is only right for the version it read](a-splice-from-a-read-is-only-right-for-the-version-it-read.md)
  — the `{version, body}` guard this doc extends to live runs.

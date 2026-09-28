---
title: "A write that splices from an earlier read is only right for the version it read"
date: 2026-09-25
category: architecture-patterns
module: project-documents visual-slots
problem_type: architecture_pattern
component: assistant
severity: high
applies_when:
  - "A writer replaces a whole document body and splices part of the stored body back in (slots, markers, a person's edits) from a read it made earlier"
  - "Adding a new AI, API, MCP or background writer for a field that already carries spliced-in content"
  - "Adding optimistic concurrency to an existing writer without changing behaviour for records that never needed it"
  - "A guarded background step stores or compares a body that a save normalizes before writing"
tags: [visual-slots, optimistic-concurrency, compare-and-swap, extract-then-splice, write-path-fan-in, temporal, idempotency, fizzy-2589]
related_components: [api, mcp-gateway, temporal, web-editor]
audience: Engineers adding or changing any path that rewrites a whole document body
owner: Fabric platform
---

# A write that splices from an earlier read is only right for the version it read

## Context

Glossy editions let an editor place **visual slots** in a Proposal or Business Case: markers that say *a visual belongs here*. A slot is the editor's own work inside a body that AI and API writers replace wholesale. So each such writer runs `preserveVisualSlots(previous, next)` (`packages/utils/lib/glossy/visual-slots.ts`). The helper strips whatever slot tags the new body carries and puts back the ones `previous` held, each under its original section.

The first version of that fan-in was correct and still lost data. `previous` is a read: the body the writer loaded before an AI call, an agent turn or a review step, sometimes minutes earlier. If a person added a slot after that read, the splice doesn't know about it, and the write deletes it. If they deleted one, the splice puts it back. The splice itself worked. It just ran against a body that was no longer the document.

The adversarial review of the branch found this path by path: first update-with-context and auto-refresh, then the MCP tool and v1 PATCH, then the in-editor assistant accept, and last the Temporal regeneration's save and version step.

## Guidance

### 1. Every whole-body writer is in the fan-in, or the invariant does not hold

The invariant is "no writer drops or resurrects a slot", so it is only as strong as the writer you forgot. For document bodies the list is:

| Writer | Where the splice source comes from |
|---|---|
| Update using context (apply) | the body read when the proposal was built |
| Auto-refresh (accept) | the body at `pendingBaselineVersion` |
| MCP `fabric_update_document` | the body the handler read and authorized |
| v1 `PATCH /documents/:id` | the existing row read before the update |
| In-editor assistant accept | the editor's body at accept time |
| Temporal regeneration (save + version step) | the body read when generation started |

When you add a writer, add a row. When a writer is deliberately left out, name it and say why (see section 5).

### 2. Guard the version the splice came from, and only when a slot is involved

Splicing plus an unconditional write is last-write-wins with a hidden side effect. The fix is a compare-and-swap on the version the splice source was read at, with the version in the `WHERE` clause, the way `updateDocument`'s `expectedVersion` already works (see the scheduling learning in Related, section 4).

Guard **only** when a slot is on either side:

```typescript
// apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts
const content =
	typeof args.content === "string"
		? preserveVisualSlots(doc.content, args.content)
		: (args.content as string | undefined);
const slotsInvolved =
	typeof args.content === "string" &&
	(hasVisualSlots(doc.content) || hasVisualSlots(args.content));

updated = await updateDocument(documentId, {
	// ...
	...(slotsInvolved ? { expectedVersion: doc.version } : {}),
});
```

The condition is what makes this safe to ship behind a default-off flag. A document with no slot on either side goes through the same unconditional write, with the same queries, as before. Tests pin that. The API and MCP slot-free cases assert that no `expectedVersion` is sent. The Temporal ones assert the exact queries: no transaction and no conditional `updateMany`.

### 3. Every writer needs its own answer to a conflict

A guard that throws the same generic error everywhere is only half done. Each surface has a different reader:

- **MCP**: an `errorResult` telling the agent to re-read with `fabric_get_document` and retry. The agent can recover on its own.
- **v1 PATCH**: `409` with code `DOCUMENT_VERSION_CONFLICT`, a contract that API clients can branch on.
- **In-editor assistant accept**: keep the accepted text in the editor, show a toast, **do not autosave**, and refetch. Autosaving at this point would push the same stale body through the unguarded path and undo the guard.
- **Temporal regeneration**: `ApplicationFailure.nonRetryable(..., "DOCUMENT_GENERATION_STALE")`. The document has moved on and will stay that way, so a retry loop achieves nothing. The run is marked failed, and the newer body is kept.

### 4. A guarded background step stores and matches the body *as saved*

The regeneration's save normalizes before writing: `contentAsSaved` repairs unclosed Mermaid fences and quote artifacts. The version step that follows receives the **raw** generated string. The first guarded version step compared the live body against the normalized form, which was correct, but it stored the raw string in the version row. That causes two problems:

- **Restore brings back the defect.** The version row is meant to show what the document displayed, and it held the malformed fence the save had repaired.
- **The retry-idempotency check misses its own row.** A retry after a lost result finds its committed row by exact field match. If one side of the match is raw and the other normalized, a normalizing body never matches, and the retry reports its own success as stale.

Normalize once, at the start of the guarded step, and use that one value for the compare, the stored row and the idempotency match:

```typescript
// packages/temporal/src/activities/project-document-generation.ts
const savedContent = contentAsSaved(content);
// ...findFirst({ where: { ..., content: savedContent, ... } })   // retry match
// ...create({ data: { ..., content: savedContent, ... } })       // the row
// ...updateMany({ where: { id, version: baselineVersion, content: savedContent } })
```

The unguarded slot-free version step still stores the raw string, as it always did. That difference is intended: section 2's promise is that slot-free runs are unchanged.

### 5. Name the writer you did not guard

The editor's ordinary manual save and autosave also write the whole body, and they are not guarded. That was a deliberate decision:

- they were already last-write-wins before slots existed;
- a version check there produces false conflicts during Yjs co-editing, where collaborators move the version constantly.

It is recorded as a waived review finding with a follow-up (a slot-aware editor save, such as a server-side slot merge). This isn't bureaucracy. The next person to read the fan-in table needs to know the gap is known, so they don't take it for an oversight or for proof that it is safe.

## Why This Matters

Extract-then-splice (see the reconciling learning in Related) is the right way to keep a person's contribution through an AI rewrite. It does not tell you *which* contribution you are keeping. A splice source is a snapshot, and every snapshot has a version. When the write isn't tied to that version, the splice quietly becomes the lost update it was meant to prevent, and it looks deliberate in the history because the AI "kept the slots".

The conditional guard is what lets the fix land on existing writers without a migration of behaviour. Records that never had spliced content keep the exact write they had, so the risk of the change is limited to the documents the feature created.

## When to Apply

- Any writer that computes `next = f(previous, generated)` and then writes `next` over the whole field.
- Any new writer for a field that already has a splice fan-in. Add it to the table and pick its conflict answer before you merge.
- Any Temporal step that is guarded on content and receives content from an earlier activity. Compare and store the same form that step's save writes.

Skip it for writers that patch a single field or append, since they never overwrite what they didn't read.

## Examples

**Before**: the splice is correct, but the write is not tied to the read:

```typescript
const doc = await getDocumentById(documentId);          // version 7, slots A and B
const next = preserveVisualSlots(doc.content, agentBody);
// ...a person deletes slot B and adds slot C: version 8...
await updateDocument(documentId, { content: next });     // B is back, C is gone
```

**After**: the same splice, guarded when a slot is involved:

```typescript
await updateDocument(documentId, {
	content: next,
	...(slotsInvolved ? { expectedVersion: doc.version } : {}),
}); // throws DocumentVersionConflictError at version 8; each surface answers per section 3
```

**Testing it:** for each guarded writer, one test asserts the slot-free call shape is unchanged, and one drives a concurrent version bump and asserts nothing was written. The regeneration tests use an in-memory document behind `$transaction` that rolls back on throw, so "nothing written" is checked on state rather than on mock calls. They also include a retry case with a body that normalization changes.

## Related

- `docs/solutions/architecture-patterns/reconciling-a-human-edit-with-an-ai-rewrite-of-one-document.md`: extract-then-splice, and "read fresh at the moment of the write". This learning adds that the splice source's version has to be enforced, not just assumed.
- `docs/solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md`, section 4: a read-then-write version check does nothing; the version belongs in the `WHERE` clause.
- `docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md`: guarded writes that return an outcome, and retries that must recognize their own committed work.
- `docs/features/glossy-editions.md`: the feature, its rollout flag and its deploy order.

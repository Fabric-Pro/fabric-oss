---
title: "Reconciling a human edit with an AI rewrite of the same document"
date: 2026-08-17
category: architecture-patterns
module: stories
problem_type: architecture_pattern
component: ai_document_editing
severity: high
applies_when:
  - "A human can edit a document while a model call is rewriting that same document"
  - "An AI proposal is reviewed and then written back over a whole field or record"
  - "A guard predicate has grown a boolean per reported timing window"
  - "A value written by one surface is the only channel by which a later model run learns it"
tags: [ai-editing, concurrency, extract-then-splice, normalized-identity, serializer-drift, human-in-the-loop, guard-predicates, data-loss]
audience: engineers building surfaces where a human and a model edit the same record
owner: web app team
---

# Reconciling a human edit with an AI rewrite of the same document

## Context

Feature maturation lets a product owner do two things at once: answer the questions a model raised, and approve the spec that model rewrote. Both actions target one column. The rewrite is proposed from a snapshot taken when the run started; the answer lands directly on the row moments later. Accepting the proposal wrote the snapshot-derived content over the whole column and erased the answer.

This is the general shape whenever a long model call and a human edit share a record. The model's proposal is stale by construction — it was computed before the human acted — so applying it as a whole-field write silently reverts anything that arrived meanwhile.

The same defect had been reported three times under different symptoms (Fizzy #1863, #1987, #1929). Each earlier fix added one more boolean to a predicate that defers the editor's rebuild while a review is open. That predicate guards the *symptom* — a refetch touching the editor — so every newly discovered timing window needed its own flag. The fifth flag did not cover the sixth window, and it never would have.

## Guidance

### 1. Splice the human's contribution back; don't try to stop the write

Preventing the collision by blocking the human (disable the controls during a run) trades data loss for a workflow restriction, and deferring the human's write until the review resolves invents a queue, a flush trigger for every terminal state a run can reach, and a window where the edit is recorded but invisible.

Prefer the shape the codebase already uses for verbatim-preserved sections: **extract the human's contribution before the rewrite lands, splice it back after.** The human's write stays immediate and durable; only the *reconciliation* is deferred, and it is pure logic rather than new state.

### 2. Identity is a normalized key, never byte equality

The two sides of the comparison come from different serializers. One is the editor's round-trip output; the other is markdown written directly by a server path. They are never byte-equal for anything with list structure — indentation, trailing spaces, and escaping all differ. A set difference over raw text therefore reports *every* entry as new and re-adds items the model already integrated, turning a data-loss bug into a duplication bug.

Derive a key from the semantically stable part (here, the question text), normalize it — collapse whitespace, strip inline decoration, drop serializer escapes — and compare keys.

Expect **more than two shapes**. A third appeared here because the baseline is built by a different helper when no run started during that mount. Enumerate the producers before declaring a format fixed.

### 3. Compare as a multiset, not a set

A set answers "is this entry present?" The real question is "how many of this entry should survive?" The same question answered twice during one run is two legitimate entries under one key; a set drops the second. Credit each key `max(countInBaseline, countInIncoming)` so an entry the model already folded in is not re-added, while a genuinely new duplicate still survives.

### 4. Know which channel actually carries the decision to the next run

Before trusting that a lost value is merely *delayed*, trace how a later model run would recover it. Here the appendix in the document body was the only channel: the agent serving a refresh receives a prompt, retrieved context, and the document text, has no database access by design, and its integration clause is conditional on an exact heading string. The decision also lived in a log table — but nothing on the refresh path ever read that table.

So losing the text did not delay the decision, it stranded it. That distinction sets the severity of the whole class, and it is not visible from the write path alone.

Corollary: if the value is restored without the exact marker the prompt clause matches, it survives as text and is invisible to every future run. Restore the marker, not just the content.

### 5. Splice above the boundary the save will split on

When the field being written is later split into several columns, appending at the end files the restored content into the wrong column. Locate the split boundary and insert above it. This one produced a second, quieter failure: the restored decisions would have landed in the acceptance-criteria column, corrupting what the test-matrix parser reads while the pending-decision count — parsed from the other column — stayed at zero, so nothing signalled it.

### 6. Reconcile at every exit, and read fresh at the moment of the write

A review has more than one exit. Accept was the obvious one; reject restored the pre-run baseline into the editor and marked it dirty, so the next ordinary save wrote that pre-answer text back — the same loss through a quieter door. Enumerate every surface that can resolve the proposal and route them through one wrapper.

Read the current state **at the moment of the write**, not from a value captured earlier. A cached copy fed by a fire-and-forget invalidation is stale exactly when the human acted a moment ago, which is precisely the case being fixed. In React, a callback whose dependency array omits the record is not rebuilt when the refetch lands; a latest-value ref or an awaited fresh read is what closes it.

### 7. When a guard grows a flag per incident, it is guarding the wrong thing

A predicate that accretes a boolean for each reported timing window is fitting the symptom. Keep it as defense in depth, but move the fix to the cause — here, making the write reconcilable instead of making the refetch avoidable.

## Why This Matters

Every failure in this family is silent. The user is told the update succeeded; the loss is discovered only by re-reading the document later. On a spec surface, the lost content is a decision someone made deliberately, and the system's own "pending" indicator is computed from the very text that was erased — so the signal disappears with the data.

## When to Apply

- A model call and a human edit can target the same record concurrently.
- An AI proposal is applied as a whole-field or whole-record write.
- A field is later split into multiple columns on save.
- A guard predicate has taken on a third flag for a third reported timing window.

## Examples

Wrong — a set difference over raw text, appended at the end:

```ts
const incoming = parseEntries(serverText);
const seen = new Set(parseEntries(baseline).map((e) => e.text));
const missing = incoming.filter((e) => !seen.has(e.text));
return `${content}\n\n${missing.map((e) => e.text).join("\n")}`;
```

Three defects: `e.text` differs across serializers so `seen` never matches and every entry is re-added; a set cannot represent the same question answered twice; and appending at the end files the result into whichever column the save's split assigns the tail.

Right — normalized key, multiset credit, boundary-aware placement, marker restored:

```ts
const credits = new Map<string, number>();       // key -> how many may be dropped
for (const e of parseEntries(baseline)) bump(credits, key(e));
const restore = parseEntries(serverText).filter((e) => !spend(credits, key(e)));
return insertAboveSplitBoundary(content, withMarker(restore));
```

`key()` collapses whitespace, strips inline decoration, and drops serializer escapes. `withMarker()` re-creates the exact heading the prompt clause matches when the incoming content no longer carries it.

## Testing this class

Assert the mechanism, not the end value — an outcome-only assertion passes against the broken implementation.

- Drive both serializer shapes of the *same* entry through the comparison and assert it is recognized as already-present, not restored. This is the assertion that would have caught the byte-equality bug.
- Cover a record that has the split boundary populated, and assert the other column is byte-identical after a save round trip.
- Cover every exit of the review, not just the obvious one.
- Prove the tests are not vacuous: revert the change and confirm they fail. A reviewer here neutered the restore call and 15 of 16 tests still passed — the suite proved the function was *called*, never that its result was saved.
- Watch for the weaker form of vacuous, where the assertion is fine but the *setup* never produces the case: a test that asserts a stale selection is dropped, yet never makes a selection, holds whether or not the dropping exists. Negative assertions ("must not appear", "must not fire twice") fail this way most often, because the absence they check for is also what an incomplete setup produces. The revert-and-confirm-red step catches both forms; nothing else does.

## Related

- `docs/solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md` — the same collision one abstraction up, and the rule that a read-then-write version check around a model call is decorative.
- `docs/solutions/architecture-patterns/prompt-text-is-the-contract-a-guard-matches-on.md` — a guard that can never arm is indistinguishable from one that was never needed.
- `docs/solutions/security-issues/a-sanitizer-that-deletes-can-reassemble-what-it-removed.md` — why a match-only normalizer's output must never be persisted; the restored slice must come from the original text.
- `docs/solutions/conventions/the-nth-special-case-means-generalize.md` — the counting rule that says a third report in one family is a missing abstraction.

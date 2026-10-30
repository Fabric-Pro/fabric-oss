---
title: "A refused AI accept must be reverted, not left dirty"
date: 2026-10-29
category: architecture-patterns
module: project-documents document-editor ai-review
problem_type: architecture_pattern
component: assistant
severity: high
applies_when:
  - "A server check can refuse a save that the editor has already applied locally"
  - "A client autosave exists beside a save path that carries extra checks (a descriptor, a base, a token)"
  - "Adding a new accept, apply or restore action to an editor that autosaves"
tags: [ai-review, autosave, optimistic-ui, preservation-check, echo-check, document-editor, bypass-by-failure, fizzy-2946]
related_components: [api, web-editor]
audience: Engineers adding a server check behind an editor action that changes the body first and saves second
owner: Fabric platform
---

# A refused AI accept must be reverted, not left dirty

## Context

On a client Proposal, accepting an AI proposal calls `projects.documents.update` with an `aiReview` descriptor (Fizzy #2946). Before the guarded write, the server checks the body: it must have kept everything outside its target and every existing diagram (preservation), and must repeat no internal answer or finding title (echo). Code: `packages/api/modules/projects/lib/document-ai-review.ts`. A refusal is `PRECONDITION_FAILED` with a `SCOPED_REVISION_REFUSAL` code.

The editor applies an accept first and saves second. So when the server refuses, the editor already holds the accepted text, marked unsaved.

## Guidance

### 1. A check that only the accept path carries is bypassed by its own failure

The first answer to a refusal was the conflict answer: keep the accepted text, show a toast, refetch. For a version conflict that is right (the document moved; the text is fine). For a check refusal it is wrong. The editor now has a dirty body, and the autosave saves dirty bodies through the plain path, which carries no descriptor. The refused text goes in unchecked. The check was bypassed by the very refusal it issued.

Rule: when a save carries a check the other save paths do not, a refusal must leave nothing dirty for those paths to pick up.

### 2. Hold the editor from Accept until the save answers

Keep the review published and the editor read-only from the moment of Accept until the save responds. No typing, no autosave and no second accept can interleave with the in-flight descriptor save.

### 3. On a check refusal, restore the accept's captured body

Restore the body **captured when the accept began**, and put it back into the room, so every tab shows it. Not the editor's baseline ref: by then the accept had already overwritten the baseline with the accepted text, so restoring "the baseline" restores the refused text. Capture the pre-proposal body as a value at the start of the accept and pass it to the restore (`restoreBeforeAiAccept(from, refused)`).

Then:

- offer the refused text once, to copy, so the person loses nothing;
- record the outcome as "not applied", which the chat's confirm card shows with the reason;
- clear the unsaved mark only for the accept's own edit; typing from before the accept that no save covered stays unsaved.

### 4. Each outcome has its own answer

| Outcome | Answer |
|---|---|
| Version conflict | Keep the accepted text and refetch (as the splice learning in Related describes) |
| Preservation or echo refusal | Restore the captured body, offer the refused text once, "not applied" |
| A rider (a change that cannot be accepted on its own) or no base to check against | "Not applied"; nothing is written |

Only a conflict keeps the old keep-and-refetch answer. Do not reuse it for a refusal because both arrive as `PRECONDITION_FAILED`; read the code.

Code: `apps/web/modules/saas/projects/components/DocumentEditor.tsx` (`restoreBeforeAiAccept` and the accept handler).

## Why This Matters

A server check is only as strong as the weakest path that can write the same body. Optimistic UI creates such a path by default: the client state is ahead of the server, and an autosave exists to push client state to the server. Any refusal that leaves the client ahead hands the refused body to the path with fewer checks.

## When to Apply

- Any editor action that applies a change locally, then saves it through a path with a server check.
- Any new check added to such a path. Ask what the editor holds after a refusal, and which writer picks it up.

## Examples

**Before**: refusal leaves the accepted text in the editor.

```text
Accept -> editor shows accepted text (unsaved) -> server: SCOPED_REVISION_REFUSAL
       -> toast, text kept -> autosave -> plain update, no aiReview -> saved unchecked
```

**After**: refusal restores the body captured at Accept.

```text
Accept -> editor read-only, review held -> server: SCOPED_REVISION_REFUSAL
       -> restore captured body into the room, offer refused text once, "not applied"
```

**Testing it:** drive a refusal and assert the editor's content equals the pre-accept body (not the baseline ref), that no plain-path save follows, and that the refused text is offered once. Add the control: with the restore removed, the autosave test must show the refused body saved.

## Related

- `docs/solutions/architecture-patterns/a-splice-from-a-read-is-only-right-for-the-version-it-read.md`: the version-conflict answer for the same accept, and why autosave must not follow it.
- `docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md`: guarded writes that return an outcome.

---
title: "Identity kept inside text that writers replace wholesale must be put back by every writer"
date: 2026-10-27
category: architecture-patterns
module: project-documents generated visuals
problem_type: architecture_pattern
component: full_stack
severity: high
applies_when:
  - "Linking a server-side record to one span of a document body that AI, API, MCP or background writers replace as a whole"
  - "Adding a writer that replaces a Proposal's Main body, or changing one that already does"
  - "Adding metadata to a diagram fence (a marker, a caption, a setting) that must survive edits and round trips"
  - "Deciding what happens to stored records when the text that pointed at them disappears"
tags: [proposal-artifact, visuals, mermaid, identity, markers, source-hash, write-path-fan-in, fnv1a, caption, fizzy-2946]
audience: engineers adding or changing a writer of document bodies, or adding identity or metadata inside a body
owner: Fabric platform
---

# Identity kept inside text that writers replace wholesale must be put back by every writer

## Context

A Proposal's visuals step generates diagrams, fact-checks a spec for each, and writes them into the document's Main body as mermaid fences (Fizzy #2946, #1390). The diagram menu then needs to know, for any fence on the page, whether Fabric generated it, whether a person has edited it since, and which spec it came from, so that Edit with instructions can regenerate it from that spec.

A body has no ids of its own. It is Markdown, and AI rewrites, the v1 API, MCP tools, auto-refresh and the editor's assistant all replace it as a whole. Anything that identifies a diagram has to live in the diagram's text, and every one of those writers is free to drop it.

## The design

**A marker line in the fence, a row keyed by its hash, and a classifier.** Pure helpers live in `packages/utils/lib/proposal-artifact/visual-identity.ts`, so the worker, the API and the editor bundle compute the same answers.

- **Marker.** A generated diagram's fence opens with one comment line, `%% fabric-visual: <id>` (12 to 32 lowercase letters or digits, minted on the server). Mermaid reads it as a comment and the editor keeps it as text. `readVisualMarker` accepts it only on the first non-blank line. A malformed marker is ordinary source.
- **Source hash.** `visualSourceHash(body)` is `v1:` plus `fnv1aHex64` of the body without its marker line and without its caption line. Line endings are normalised to `\n`, trailing whitespace is trimmed from each line, and leading and trailing blank lines are dropped. The editor's save rewrites fences and trims trailing whitespace, so the hash comes out the same after a load-and-save round trip. The hash is a label, not a security boundary: anyone with edit rights can write any fence.
- **Spec row.** `ProjectDocumentVisualSpec` stores one row per `(documentId, visualId, sourceHash)` (`@@unique` in `schema.prisma`), with the spec, its own hash, the kind and the origin. Rows are append-only, so a restored older version's fence still finds the row it was generated with. The spec never reaches a client. Clients get ids, hashes, kind and origin only (`VisualSpecSummary`).
- **Classifier.** `classifyVisualFences(markdown, rows)` gives every diagram fence, in document order, one state:
  - `generated`: a valid marker, the first fence with that id, and a row with this id and this hash. It also returns the row's origin, `STEP` (the visuals step) or `INSTRUCTION` (Edit with instructions).
  - `edited`: a valid marker and rows for the id, but none with this hash. A person changed the diagram.
  - `detached`: the id already appeared on an earlier fence (a copy), or there is no row for it at all (pasted from another document).
  - `none`: no valid marker.

  The editor reads these states in `apps/web/modules/saas/projects/lib/mermaid-diagram-index.ts`: `useDiagramOrigin` feeds the menu's line saying whether Fabric added the diagram or it was updated with instructions, and `diagramEditVisualId` gives a detached fence no id to edit from.

## The rule: every whole-body writer puts dropped markers back

A model asked to rewrite a section may return the diagrams it left alone without their marker lines, because to the model they are only comments. Each writer that replaces Main therefore runs `preserveVisualMarkers(previous, next)` next to the existing `preserveVisualSlots`, always in the same order:

```ts
preserveVisualMarkers(previous, preserveVisualSlots(previous, next));
```

| Writer | Call site |
|---|---|
| MCP document update | `apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts` |
| v1 API document update | `packages/api/modules/v1/documents.ts` |
| Update using context (procedure) | `packages/api/modules/projects/procedures/documents/update-with-context.ts` |
| Update using context (core) | `packages/temporal/src/lib/update-with-context-core.ts` |
| Auto-refresh proposal accept | `packages/api/modules/projects/procedures/documents/apply-auto-refresh-proposal.ts` |
| Generation save | `packages/temporal/src/activities/project-document-generation.ts` |
| Assistant edit applied in the editor | `apps/web/modules/saas/projects/components/DocumentEditor.tsx` |

`preserveVisualMarkers` puts a marker back **only where the body is unchanged.** It considers each unmarked diagram fence in `next` whose source hash equals the hash of a marked fence in `previous`. Each marker from `previous` is used at most once and in order, so two identical diagrams get back their own ids. A marker is never restored when `next` already carries that id. A fence whose body changed stays unmarked, because the stored spec no longer describes it. A marker that `next` carries is never touched. Only the restored lines are inserted, with the container prefix a blockquote or a list item needs. Every other byte of `next` is unchanged, CRLF included.

**Losing a marker deletes nothing.** If a writer outside this list drops a marker, or a person deletes the line, the fence classifies as `none` and the spec row stays where it is. The cost is a diagram that no longer shows its origin and can no longer be edited from its spec. Nothing is destroyed, and restoring an earlier version brings the identity back. No code path deletes a spec row because a marker disappeared, so a missed writer costs a feature, not data.

`previous` in each writer is a read, and the rule from [a-splice-from-a-read-is-only-right-for-the-version-it-read.md](a-splice-from-a-read-is-only-right-for-the-version-it-read.md) applies: it is the body that particular writer loaded and authorized, not a second read. Today only a visual slot switches on the version-guarded write. A marker restore only adds a comment line, and only to a fence whose content matched.

## Metadata beside the identity stays out of the hash

Captions show why the hash has to exclude more than the marker. A caption first lived only in an editor attribute that never reached Markdown, so every document lost its captions on reload (#1399). It now lives in the fence body as a second comment line, `%% caption: <text>`, right after the marker (`packages/utils/lib/proposal-artifact/diagram-caption.ts`). `visualSourceHash` leaves it out, so changing a caption does not turn a `generated` diagram into an `edited` one. Any new per-diagram setting carried this way needs the same two decisions: where the line sits relative to the marker, and whether the hash includes it.

## How to test

`packages/utils/__tests__/proposal-artifact-visual-identity.test.ts`:

- source hash: versioned, excludes the marker, ignores line endings, trailing whitespace and surrounding blank lines, changes when a label or the indentation changes, and keeps a malformed marker in the hashed source;
- classifier: unchanged is `generated` with its origin, one changed label is `edited`, a second fence with the same id and a fence from another document are `detached`, a hand-written fence is `none`, and an older version restored matches its own row;
- `preserveVisualMarkers`: restores a dropped marker on an unchanged diagram and changes nothing else; does not mark a changed body; leaves a kept marker alone; restores the right one of two identical diagrams; keeps CRLF byte for byte; handles blockquote and list prefixes; does not mark a fence that would stop reading as a diagram; composes with slot preservation;
- caption: written right after the marker, which stays the first line.

When you add a writer of Main, add it to the table above and test that a diagram it did not change keeps its marker.

## Related

- [a-splice-from-a-read-is-only-right-for-the-version-it-read.md](a-splice-from-a-read-is-only-right-for-the-version-it-read.md): the same writer list for visual slots, and why the splice source must be the authorized read.
- [a-react-node-view-without-node-view-content-shows-its-nodes-text.md](../ui-bugs/a-react-node-view-without-node-view-content-shows-its-nodes-text.md): the editor node that keeps the marker and caption as its text.
- [a-printed-diagrams-label-size-is-a-number-you-can-compute.md](../design-patterns/a-printed-diagrams-label-size-is-a-number-you-can-compute.md): how the same diagrams print.

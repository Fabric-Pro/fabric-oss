---
title: "A picker's accept attribute and its validation gate must derive from one vocabulary"
date: 2026-07-23
category: conventions
module: web saas attachments copilot stories
problem_type: convention
component: full_stack
severity: high
applies_when:
  - "A file picker's `accept` attribute is built from a shared allowlist while the validation that runs on the picked file is hand-rolled separately"
  - "Adding or removing a supported file format anywhere in an attachment surface"
  - "Two surfaces are meant to accept the same formats but each keeps its own list"
tags: [attachments, accept-attribute, validation, allowlist, shared-vocabulary, drift, loom, nexus, feature-assistant, xlsx]
related_components: [ai-assistant, stories]
---

# A picker's accept attribute and its validation gate must derive from one vocabulary

## Context

A file input has two independent places that decide which formats are allowed:
the `accept` attribute (what the OS picker *offers*) and the code that runs when
a file is chosen (what the surface actually *admits*). These answer the same
question and must give the same answer — but nothing structural forces that.
When they drift, the picker offers a file the gate then refuses, and the user
gets "File type not supported" for a file the UI just invited them to pick.

This surfaced as a reported bug: `.xlsx` could not be attached in Loom, though
it worked in Nexus. The `accept` attribute had been fixed to advertise `.xlsx`
(derived from the shared `@repo/utils/ai-chat-attachment` vocabulary), but the
two validation sites behind it — `handleFileSelect` and `onPasteNonImageFiles`
in `FabricDirectChat.tsx` — still used hand-rolled `allowedTypes` arrays plus a
literal extension regex `/\.(pdf|docx|txt|md|html|json|png|jpe?g|gif|webp|tiff?)$/i`
that never listed `xlsx` or `csv`. Nexus worked only because its validation had
already been routed through the shared allowlist.

## Guidance

**Both the `accept` attribute and every validation gate behind it must derive
from the same allowlist. A local array or regex that restates the formats is a
guaranteed future drift — delete it in favor of the shared source.**

The concrete vocabulary for AI-chat/attachment surfaces lives in
`@repo/utils/ai-chat-attachment`:

- `DEFAULT_AI_CHAT_MIME_ALLOWLIST` — every admitted MIME (server-authoritative set).
- `AI_CHAT_SERVER_ALLOWED_EXTENSIONS` — the extension guard for surfaces that
  run no canvas step (they accept TIFF); `AI_CHAT_ALLOWED_EXTENSIONS` is the
  narrower client set for canvas-compressing surfaces.
- `buildAiChatAcceptAttribute([...])` — the `accept` string, built from that
  same vocabulary.

When `accept` and the gate both call these, adding a format to the vocabulary
updates the picker and the gate at once. The gate becomes a subset check
against the allowlist, never a second copy of it.

```ts
// Before — accept is derived, but the gate restates the list and omits xlsx/csv
const allowedTypes = ["application/pdf", "...wordprocessingml.document", ...];
if (
  !allowedTypes.includes(file.type) &&
  !file.name.match(/\.(pdf|docx|txt|md|html|json|png|jpe?g|gif|webp|tiff?)$/i)
) { reject(); }

// After — the gate reads the same vocabulary the accept attribute is built from
if (
  !DEFAULT_AI_CHAT_MIME_ALLOWLIST.includes(file.type) &&
  !AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test(file.name)
) { reject(); }
```

The extension check is the fallback for a reason worth keeping: paste and drop
routinely deliver files with an empty `file.type`, so the MIME check alone
would refuse a validly-named `.xlsx` dragged out of another app.

## Why This Matters

The failure mode is uniquely confusing because the UI contradicts itself in one
gesture: the picker filters to `.xlsx`, the user picks one, and the same surface
answers "not supported." It reads as random breakage, not a rule, so it gets
reported as a mystery rather than diagnosed. And it hides from tests that check
each side alone — the accept attribute test passes, a validation test with a
`.pdf` fixture passes, and the gap between them is exactly the untested seam.

It is also silent to reviewers: two lists that happen to agree today look
correct, and the drift only appears when someone adds a format to one. That is
why a review comment ("keep these in sync") does not hold — the invariant has
to be structural, one list, not a promise to remember.

## When to Apply

- Any file input where `accept` is computed but validation is written by hand,
  or vice versa. Route both through the one allowlist.
- Whenever you add or drop a supported format: change the vocabulary, not a
  call site, and let the picker and gates move together.
- When two surfaces are supposed to accept the same set. The three AI-chat
  attachment surfaces (Feature Assistant, Loom Direct, Nexus) now all gate on
  the shared vocabulary; the Feature Assistant deliberately uses the narrower
  *client* set because it compresses images through a canvas and cannot
  originate TIFF — a legitimate difference, still expressed by choosing which
  shared constant to read, never by a local list.

This is a sibling of the "fan-in" rule in
`docs/solutions/design-patterns/prompt-context-fan-in-must-join-not-assign.md`:
both say a value with more than one contributor must derive from one source
rather than be restated per site. There it was a prompt string assembled by
several producers; here it is a format allowlist read by an advertiser and an
enforcer.

## Examples

**The drift guard that makes this enforceable.** A prose rule rots; the
invariant is pinned by `apps/web/__tests__/copilot/attachment-surface-drift.test.ts`,
which reads each surface's source and asserts:

```ts
// No surface may hand-roll the validation array again.
for (const [, path] of Object.entries(SURFACES)) {
  expect(read(path)).not.toMatch(/allowedTypes\s*=\s*\[/);
}

// The two client-validating surfaces gate on the shared vocabulary.
expect(source).toContain("DEFAULT_AI_CHAT_MIME_ALLOWLIST");
expect(source).toContain("AI_CHAT_SERVER_ALLOWED_EXTENSIONS");
```

A reintroduced local `allowedTypes` array, or a surface that stops reading the
shared allowlist, turns the guard red — the drift is caught at the seam that a
per-side unit test cannot see.

**A second instance in the same change, only reachable by the edge case.**
Nexus's `inferMimeTypeFromFilename` — a hand-rolled extension→MIME map used when
a pasted file has an empty `type` — was also missing `xlsx`/`csv`. With a real
picker the file's `type` is set, so the map is skipped and Nexus "worked"; the
gap only bit a typeless paste. Same class of bug (a restated format list drifts),
different trigger. The lesson: when you find one drifted list, grep for its
siblings — the format enumeration tends to exist in more than one place.

## Second shape: a shared core with per-surface extras

The rule above pins one vocabulary per surface. It says nothing about surfaces
that admit *overlapping* sets, and that gap produced its own drift: the workspace
document picker sat at five formats while project context carried thirteen, and
JSON was attachable in an AI chat but not uploadable as project context even
though a single extractor served both. Neither surface restated the other's list,
so no guard fired — each was internally consistent and collectively wrong.

The fix is composition, not merging. `packages/utils/lib/document-format-core.ts`
holds the formats extractable as AI context and projects them into an allowlist,
an `accept` attribute, labels, and a forced-extension map. Each surface builds its
vocabulary as *the core plus its own named extras*:

```ts
// context-upload.ts — the surface that takes screenshots and Excalidraw scenes
export const CONTEXT_UPLOAD_MIME_TYPES = {
  ...DOCUMENT_FORMAT_CORE,
  ...CONTEXT_UPLOAD_ONLY_FORMATS,
};

// workspace-document-upload.ts — a document library, so the core alone
const WORKSPACE_DOCUMENT_FORMATS = DOCUMENT_FORMAT_CORE;
```

Merging the two into one allowlist would have been the wrong move: it would hand
workspace documents the image and diagram formats nobody asked it to accept.
Per-surface vocabularies are deliberate (see `CONCEPTS.md` § Format vocabulary);
what they should not do is each maintain their own copy of the shared part.

Two things follow, both learned the hard way in Fizzy #2149:

**Derive every projection, including the ones that are not the accept
attribute.** The forced-extension map is the one most likely to drift, because a
format added to the core later reaches every accept attribute automatically and
would reach no hand-written forced map at all. If a surface needs a projection,
the core produces it.

**Check where the shared primitives are already consumed before extending them.**
The obvious way to rescue an untyped `.xml` is to add a key to `EXTENSION_MIME` in
`attachment.ts` — but `ATTACHMENT_ACCEPT_ATTR` is built from that map's keys and
feeds the story-attachment picker, so the new formats would have been advertised
on a fourth surface whose gate refuses them. The per-surface forced map was the
correct seam. A shared primitive has more consumers than the one you are looking
at; grep for them before widening it.

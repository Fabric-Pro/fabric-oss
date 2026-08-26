---
title: "Count the special cases — the Nth one means generalize, not add another"
date: 2026-08-10
category: conventions
module: web saas attachments projects workspaces utils
problem_type: convention
component: full_stack
severity: high
applies_when:
  - "A bug report names one specific instance of something (one file format, one provider, one locale) and the obvious fix is a branch for that instance"
  - "The function you are about to edit already contains two or more hand-written branches of the same shape"
  - "A previous fix solved the general form of this problem somewhere else in the codebase and stopped there"
  - "You are about to answer 'is X supported?' by reading one constant"
tags: [special-case, generalize, allowlist, mime, drift, scope, upload, attachments, surface-scoping]
related_components: [attachments, uploads]
audience: Engineers about to add a branch to a function that already has several of the same shape
owner: Fabric platform
---

# Count the special cases — the Nth one means generalize, not add another

When to stop special-casing and fix the general rule instead.

- **Audience**: Engineers about to add a branch to a function that already has several of the same shape
- **Owner**: Fabric platform

## Context

A ticket reported that `.md` files could not be uploaded, and asked for `.md` to be added as a supported format.

`.md` was already allowlisted on every upload surface in the product. The defect was not membership but **identification**: the server recognised a file by the MIME type the browser reported, the browser fills that from the operating system's registration, and an OS with no registration for the extension reports nothing. The client substituted a placeholder, the server did not recognise the placeholder, and the file was refused — by an error message that listed MD among the supported types in the same sentence.

The revealing part was the history. The same function already contained hand-written rescues for exactly this failure:

- Fizzy #1942 hit it on `.excalidraw` and added a branch for `.excalidraw`
- Fizzy #1684 hit it on `.html` and added a branch for the `.html` family
- Fizzy #1778 hit it on the *ticket-attachment* surface and fixed the general case — an extension fallback — but only there
- Fizzy #2139 was the fourth report, and the obvious fix was a fourth branch

Adding that fourth branch would have shipped a working `.md` upload. It would also have left **eleven other advertised formats broken**, because the picker advertised sixteen extensions and only four had been rescued by hand.

## Guidance

**Before adding a special case, count the ones already there.** One is a special case. Two is a coincidence. Three is a pattern with a missing abstraction, and the next ticket is already written.

When the count is at or above three, the correct fix is not the branch that closes your ticket. It is the general rule the branches are all approximations of — and the measure of the fix is how many *unreported* instances it closes, not whether the reported one now works.

Three practices follow:

**Count what a general fix would close.** Derive the full set from the same source the feature advertises to users. Here that meant deriving the test table from the picker's own `accept` attribute rather than hand-listing formats:

```ts
const advertisedExtensions = CONTEXT_UPLOAD_ACCEPT_ATTR.split(",").map(
    (ext) => ext.replace(/^\./, ""),
);

it.each(
    advertisedExtensions.flatMap((ext) =>
        ["", "application/octet-stream"].map((mime) => [ext, mime] as const),
    ),
)("resolves .%s reported as %j", (ext, mime) => {
    expect(contextUploadConfigFor(resolveContextUploadMime(mime, `design.${ext}`)))
        .toBeDefined();
});
```

That table failed on twelve extensions before the fix. A `.md`-only branch would have turned one of them green and left the count invisible.

**Look for the general fix that already exists elsewhere.** Before writing an abstraction, grep for one. The general form here was already implemented, tested, and shipped on a sibling surface — and a prior plan had even diagnosed this exact function as *"the project-contexts shim … only special-cases one MIME and fails open"* and routed around it rather than fixing it. A diagnosis recorded and not acted on is a special case waiting to happen again.

**Scope a "does X work?" answer to the surface you actually read.** This repo deliberately keeps one format vocabulary *per surface*, so "I read the constant and `.md` is allowlisted" is a true answer about one vocabulary and a false answer about the product. An earlier solution doc recorded exactly that unscoped conclusion, and it read as a product-wide all-clear for months. Name the surface in the finding, or the next reader inherits a false negative.

## Why This Matters

The cost of the wrong fix is not the fix — it is the *next three tickets*, each arriving as a separate report, each looking small, each getting its own branch. Four tickets across three surfaces produced four branches and left the underlying defect untouched.

The cost compounds in a second way. Every hand-written branch makes the function look more deliberate than it is. By the fourth reader, a list of four extension checks reads as a considered allowlist rather than as sediment from four unrelated bug reports, and the missing generalization becomes progressively harder to see.

There is also a false-confidence cost. A test suite that pins the four rescued formats is green, and green on the rescued cases is exactly what stops anyone counting the unrescued ones.

## When to Apply

- The function you are editing already has two or more branches of the same shape, and you are about to add the next one
- A bug report names one instance of a class of things — one format, one provider, one locale, one status value
- A prior fix solved this problem's general form somewhere else and did not propagate
- You can state the general rule the existing branches all approximate. If you cannot, add the special case and record what you could not generalize
- **Not** when the branches are genuinely unrelated, or when one case is deliberately different for a reason recorded in the code — a documented exception is not sediment

## Examples

**Before** — four hand-written rescues, each from its own ticket, and every other format left refused:

```ts
const ext = filename.toLowerCase().split(".").pop();
if (ext === "excalidraw") {
    return EXCALIDRAW_MIME;                  // #1942
}
if (ext === "html" || ext === "htm" || ext === "xhtml") {
    return "text/html";                      // #1684
}
if (mimeType !== "application/vnd.ms-excel") {
    return mimeType;                         // everything else: unrescued
}
```

**After** — the deliberate exceptions stay and say why; everything else defers to the general resolver that already existed:

```ts
// Extensions whose canonical type is forced ahead of the declared value,
// because the declared value is routinely wrong for them.
const forced =
    ext && Object.hasOwn(FORCED_EXTENSION_MIME, ext)
        ? FORCED_EXTENSION_MIME[ext]
        : undefined;
if (forced) {
    return forced;
}
return (
    resolveAttachmentMime(filename, mimeType, CONTEXT_UPLOAD_MIME_ALLOWLIST) ??
    mimeType
);
```

The legacy-Excel branch disappeared entirely — the general rule reached the same answers, which is the usual sign that a special case was an approximation. The `.excalidraw` and `.html` branches stayed, because they are a genuine exception (the declared type is untrustworthy for those extensions) rather than sediment, and the comment now says so.

One extension short of a branch is still a case worth pinning. Keep a negative test for the case the deleted branch used to handle — here, that a genuine `.xls` stays refused — because the positive cases pass either way and would not catch a botched deletion.

## Related

- `docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md` — the sibling rule about *where* a format list lives. This entry is about *when* to stop adding to one. Its closing instruction ("when you find one drifted list, grep for its siblings") is the same instinct applied to lists rather than branches.
- `docs/solutions/conventions/derive-query-invalidation-keys-never-hand-build-them.md` — the same generalization, stated for a different hand-authored value: "the problem is not one wrong shape, it is that hand-authoring the filter at all is the defect."
- `docs/solutions/architecture-patterns/reuse-story-attachment-pipeline-preserve-ai-isolation.md` — carries the surface-scoping correction described above.
- `docs/plans/2026-08-10-001-fix-untyped-file-upload-rejection-plan.md` — the plan for the generalizing fix, including the count of what it closed.

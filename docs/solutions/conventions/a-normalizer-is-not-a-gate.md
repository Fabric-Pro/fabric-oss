---
title: "A resolver that cannot refuse is not a gate"
date: 2026-08-12
category: conventions
module: web saas uploads utils
problem_type: convention
component: full_stack
severity: high
applies_when:
  - "A surface has both a resolver that normalizes a value and a client that must refuse what the surface does not accept"
  - "A resolver ends `?? input` or otherwise returns the caller's value when nothing resolves"
  - "Adding a resolution step (forced extensions, aliases, fallbacks) to a resolver that already has callers"
  - "Reviewing a `if (!resolved)` check and assuming it fails closed"
tags: [uploads, resolver, gate, fail-closed, normalization, mime, vocabulary, drift]
related_components: [attachments, workspaces, projects]
---

# A resolver that cannot refuse is not a gate

## Context

The upload surfaces each expose two functions that look interchangeable and are not. One resolves a file's effective MIME type; the other looks that type up in the surface's vocabulary. Only the second one can refuse.

The resolver deliberately cannot. `resolveWorkspaceDocumentMime` ends `?? mimeType` — returning the caller's own value when nothing resolves — and its comment says why: the workspace server normalizes at two persistence points and has never gated on file type, so a resolver that returned `null` would turn normalization into a refusal and break uploads that succeed today.

That makes `if (!resolved)` a gate that never fires. And the shape is inviting, because a *different* shared helper — `resolveAttachmentMime` — genuinely does return `null` when nothing resolves. Two functions, similar names, opposite failure contracts.

Fizzy #2149 hit this from both directions at once. `DocumentUploader.validateFile` gated with `resolveAttachmentMime(...)` and `if (!resolved)`, which was correct in isolation. When the surface's own resolver gained a forced-extension layer — the only rescue path for newly admitted `.xml`, `.json` and `.yaml` — the picker never ran it, because it was calling the shared helper directly. The picker would have advertised every new format and then refused it: the exact advertise-then-refuse bug the sibling convention doc exists to prevent, reintroduced through the gate rather than the list.

The obvious repair makes it worse. Swapping in the surface resolver so the forced layer runs leaves `if (!resolved)` testing a value that is never falsy, so the gate stops refusing anything at all — a picker with no type validation, and every test still green because the positive cases pass either way.

## Guidance

**Resolve and gate are two calls, not one.** A resolver answers "what type is this?" A vocabulary lookup answers "do we accept that?" Never let the resolver's return value carry the refusal.

```ts
// The gate. Two steps, and the second one is what refuses.
const resolved = resolveWorkspaceDocumentMime(file.name, file.type);
const config = workspaceDocumentConfigFor(resolved); // undefined => refuse
if (!config) {
	return unsupportedTypeReason(file.name, resolved);
}
```

Three rules follow:

1. **If a resolver returns the caller's value on failure, say so in its doc comment and name the lookup that pairs with it.** A caller reading the signature cannot tell `string` from `string | null`.
2. **Every surface that needs to refuse exports a null-returning lookup.** `contextUploadConfigFor` and `workspaceDocumentConfigFor` are that pair's second half. Both use `Object.hasOwn` rather than a plain index, because a plain-object index is truthy for inherited keys — a file declaring `mimeType: "constructor"` would pass a `if (!config)` check and then read `undefined` for its size limit, which every comparison passes.
3. **When you add a step to a resolver, grep its callers before assuming they get it.** A resolution step added to a function the enforcement path does not call is invisible: the vocabulary widens, the picker advertises, and the gate refuses.

## Why This Matters

Both failure directions are silent, and tests do not catch either by default.

Gating on the wrong resolver fails closed on exactly the formats you just added — nothing throws, the picker simply refuses what it offers. Gating on a resolver that cannot refuse fails *open* — every file passes the client, and the server catches it only where a server gate exists. The workspace surface has none by design, so there the client is the only enforcement.

Positive-case tests pass under both faults. A test that uploads a supported file and asserts it queues is green whether the gate is correct, absent, or checking the wrong thing. What catches it is a negative case — assert a `.pptx` is still refused after any change to the resolution path — and a derived table that exercises the newly admitted formats through the *surface* resolver rather than the shared one.

## When to Apply

- Any surface with a normalize-vs-refuse split, which in this codebase means every upload picker.
- Whenever a resolver grows a step: forced extensions, alias canonicalization, a new fallback.
- When reviewing a `if (!resolved)` check — confirm the function on the right actually returns `null`.
- When two similarly-named helpers exist and only one fails closed.

## Examples

**The bug, as it was written.** The gate is correct against `resolveAttachmentMime` and blind to the surface's own resolution:

```ts
// DocumentUploader.validateFile — before
const resolved = resolveAttachmentMime(
	file.name,
	file.type,
	WORKSPACE_DOCUMENT_MIME_ALLOWLIST,
);
if (!resolved) {
	return "Unsupported file type";
}
```

`resolveAttachmentMime` reads the shared extension map, which deliberately carries no `xml`, `json` or `yaml` key — those extensions are rescued by each surface's forced map instead, because the shared map also builds a fourth surface's `accept` attribute. So the forced layer never ran here, and an untyped `.yml` was advertised and refused.

**The repair that looks right and is worse:**

```ts
// Runs the forced layer — and stops refusing anything.
const resolved = resolveWorkspaceDocumentMime(file.name, file.type);
if (!resolved) {
	return "Unsupported file type"; // never true: `?? mimeType`
}
```

**The guard that makes it structural.** `attachment-surface-drift.test.ts` asserts each picker names its gate:

```ts
it.each(Object.entries(PICKER_SURFACES))(
	"%s gates on the vocabulary before the file is queued",
	(_surface, { path, gateSymbol }) => {
		expect(read(path)).toContain(gateSymbol);
	},
);
```

Known limitation: this is a whole-file substring match, and both context surfaces name the symbol in comments above the gate — deleting the call while keeping the comment keeps it green. Anchoring the assertion to `contextUploadConfigFor(` would close that.

**Negative coverage is what actually catches it.** The two positive cases pass with or without the gate:

```ts
it("refuses a format outside the allowlist", () => {
	expect(gate("photo.png", "image/png")).toBeUndefined();
	expect(gate("deck.pptx", "")).toBeUndefined();
	expect(gate("sheet.xls", "application/vnd.ms-excel")).toBeUndefined();
});

it("refuses an inherited object key masquerading as a type", () => {
	expect(gate("x.constructor", "constructor")).toBeUndefined();
});
```

## Related

- `docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md` — the sibling rule about the *list*. This one is about the *gate* that reads it; the same advertise-then-refuse bug arrives through either.
- `docs/solutions/conventions/the-nth-special-case-means-generalize.md` — why the forced-extension layer exists at all rather than a fifth hand-written branch.
- `docs/attachment-surface-map.md` — which vocabulary and which gate each surface owns.
- `CONCEPTS.md` — **Declared type** distinguishes a claimed type from a resolved one; this doc adds that resolving is still not gating.

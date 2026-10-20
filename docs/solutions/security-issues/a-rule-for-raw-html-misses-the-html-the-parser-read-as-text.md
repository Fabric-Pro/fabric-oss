---
title: "A rule for raw HTML misses the HTML the parser read as text"
date: 2026-10-16
category: security-issues
module: temporal proposal-export markdown preparation (prepareExportMarkdown)
problem_type: security_issue
component: background_job
severity: high
symptoms:
  - "An uploaded image whose file name held a double quote printed its raw <img> tag in the exported PDF and Word file"
  - "The tag's signed storage URL became a live link and its data-s3-key was printed as text"
  - "No IMAGE_DROPPED warning was reported; the image reader saw no image at all"
  - "Every test for the uploaded-image rules passed, because every fixture was a well-formed tag"
root_cause: logic_error
resolution_type: code_fix
related_components: [frontend, documents]
tags: [markdown, mdast, raw-html, img-tag, signed-url, storage-key, export, fizzy-2946]
audience: engineers writing code that reads, prints or exports raw HTML from a stored Markdown document
owner: Fabric platform
---

# A rule for raw HTML misses the HTML the parser read as text

## Problem

The Proposal export (Fizzy #2946) reads uploaded images out of Main, where the editor saves each one as a raw `<img …>` tag carrying a signed URL and the object's storage key. Every rule the export has for that HTML — read it as an uploaded image, or never print HTML that names a stored object — runs on mdast `html` nodes. A tag the Markdown parser could not read as HTML never becomes an `html` node, so none of those rules ran, and the writers printed the tag as ordinary text: signed URL, storage key and all.

## Symptoms

- An uploaded image whose file name contained an odd number of double quotes (`27" display.png`) came out of the PDF and Word export as its raw tag text.
- The signed URL inside it was turned into a live link by the GFM autolink rule, so the Word file also carried it as an external relationship.
- The tag's `data-s3-key` (the document's media path, with its project and document ids) was printed in the client document.
- No `IMAGE_DROPPED` warning: the image scanner counts refused tags among `html` nodes only, and there was none.

## What Didn't Work

- **Making the tag reader more careful.** An earlier review had found that a `<` or `>` inside `alt` broke the reader, and the fix made it quote-aware (`readUploadedImageTag`, `packages/temporal/src/lib/proposal-export/document-content.ts:226`). That fixed tags the parser *had* read as HTML. It could not help here: the reader is only ever handed `html` nodes, and an unbalanced quote means the parser never produces one.
- **Testing the rules with editor-shaped fixtures.** Every fixture was a well-formed tag, so every rule looked complete. The editor writes `alt` from the file name without escaping it (`apps/web/modules/saas/projects/lib/editor-markdown-save.ts:227`, `alt="${alt}"`; the caption at `:235` *is* escaped), so the malformed shape is a real one, not a contrived one.
- **Reasoning from the HTML spec.** In a browser, the same malformed tag still parses into an `<img>` element with odd attributes. CommonMark is stricter: an HTML block (rule 7) and inline raw HTML both need a *complete, valid* open tag. An attribute like `display.png"` is not valid, so remark falls back to a paragraph of text, and remark-gfm then autolinks the `https://…` it finds inside. Only running the real parser on the real shape showed it.

## Solution

Hand the paragraph back to the raw-HTML rules instead of adding text-level copies of them. During the export's tree pass, a paragraph whose source opens with an image tag but whose first child is not an `html` node is replaced by an `html` node holding its exact source (`unreadImageTag`, `packages/temporal/src/lib/proposal-export/markdown.ts:180`; the start check at `:93` requires whitespace after `img`, so prose that merely mentions `<img>` is left alone):

```ts
// A paragraph the parser read as text, though its source is an image tag.
if (node.type !== "paragraph" || node.children[0]?.type === "html") {
	return node; // a tag the parser did read is left to the html rules
}
const source = markdown.slice(start, end);
if (!IMAGE_TAG_START.test(source)) {
	return node;
}
return { type: "html", value: source, position: node.position };
```

From there the existing rules apply unchanged. The tag reader refuses it (unbalanced quote). The raw-HTML fallback (`rawHtmlFallback`, `document-content.ts:196`) omits it because it names a stored object (`namesStoredObject`, `:176`). The image scanner counts it as a refused upload, so the reader is told an image was dropped (`extract-document-images.ts:127-135`, reported at `:160`).

Defence in depth landed beside it, because the same session found further shapes of the same leak. Storage references (`document-media/`, `project-brand/` and the other upload prefixes, and `X-Amz-Signature`/`X-Amz-Credential`) are stripped from text, code, image alt and caption, the title and party names, and are refused as link targets (`STORAGE_REFERENCE` and `withoutStorageReferences`, `document-content.ts:56` and `:70`).

## Why This Works

The rules were never wrong; they were attached to a node type, and the dangerous input could arrive as a different node type. Restoring the node type the rules are written for means there is one set of rules, not one per shape the parser might produce. Recognizing the paragraph by its *source* rather than its parsed children matters, too. The parsed children (text plus an autolink) have already lost the quoting that made the tag a tag, while the source slice is exactly what the editor saved.

## Prevention

- When a rule protects content keyed on a parser node type (`html`, `image`, `link`), ask what that content looks like when the parser *rejects* it, and route that shape to the same rule. Malformed input rarely disappears; it changes node type.
- Test with the producer's real output, including its escaping gaps, not only with hand-written well-formed fixtures. The regression tests here use the editor's shape with a quote in `alt`, through the parser and both writers. The tests are `markdown.test.ts` ("hands an uploaded image tag the parser read as text back as raw HTML"), `build-theme-html.test.ts` and `build-docx.test.ts` ("never prints or links an image tag the parser could not read, or one with no key"), and `extract-document-images.test.ts` ("counts an image tag the parser could not read, and one with no key, as dropped without reading either"). Reverting `unreadImageTag` fails all four, as a mutation run in this session showed.
- Any new consumer of Main's raw HTML (another export, a preview, a renderer) inherits this hazard. Run it through `prepareExportMarkdown` or repeat the tree-pass step; do not rely on `html` nodes alone.
- The root cause in the editor (unescaped `alt`) is a separate, pre-existing fix. It only prevents new broken tags; Main that is already stored keeps them, so the reader-side handling stays necessary either way. As of this writing it is unfixed, and the live page's handling of the same tag was not checked in this session.

## Related Issues

- `docs/solutions/security-issues/a-guard-belongs-on-the-copy-that-gets-read.md`: the same shape of mistake, a guard placed on a path the data did not take.
- `docs/solutions/design-patterns/a-safeguard-can-hold-by-coincidence.md`: a rule that held only for the input shapes it happened to see.
- Fizzy #2946 (Proposal artifact, server-side export). Fixed on branch `feature/2946-export-server`; the PR had not been opened as of this writing.

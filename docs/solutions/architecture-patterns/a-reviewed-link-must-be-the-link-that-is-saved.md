---
title: "A reviewed link must be the link that is saved"
date: 2026-11-02
category: architecture-patterns
module: project-documents diff-review document-editor
problem_type: architecture_pattern
component: web-editor
severity: high
applies_when:
  - "A diff, preview or review renders a document that a later save rewrites"
  - "Invisible markers, placeholders or escapes travel through Markdown that contains link or image destinations"
  - "A server check compares a stored body with a body the editor's save normalized"
tags: [diff, review, accept, link, href, percent-encoding, markdown-it, turndown, preservation-check, fizzy-2946]
related_components: [api, utils]
audience: Engineers changing the inline diff, the editor save, or the AI accept checks
owner: Fabric platform
---

# A reviewed link must be the link that is saved

## Context

The inline diff wraps changed words in invisible marker tokens (zero-width and non-breaking spaces around `ADD_START` / `DEL_START`), renders the result with markdown-it, and lets a person accept or reject it in TipTap. The save then serializes the editor with Turndown (Fizzy #2946).

A word diff split a link's Markdown into words, so a changed URL got its markers inside the `(...)`. markdown-it percent-encoded them into the `href`, a host became punycode, and accepting saved the corrupted URL. The repair grew into a rule with several parts. Each part was found because the review and the save saw different bytes.

## Guidance

### 1. Diff a destination as one atom

Replace every link, image, autolink and raw `<img>` / `<a>` construct with a placeholder word before the word diff, and restore it before the markers go on. A changed link is then deleted and inserted whole. Markers never reach a destination, a title or an attribute.

- Key the placeholder on the form the agent reads. The agent reads Turndown escapes removed, so an echo of a stored `[\[S2\]](…)` is no change.
- A reference-style link whose definition changed becomes an inline link before the diff, as the save writes it. Unchanged references stay as written: rewriting every one loses links wherever markdown-it reads them differently from the rewrite. A plain-text review, such as the prompt editor, gets no rewrite at all.
- A streaming diff holds back a link that has only begun, so an unchanged link does not flicker as a deletion. Its cut never splits a placeholder.

Code: `extractLinksForDiff`, `streamedWhole` and `cutOutsidePlaceholders` in `apps/web/modules/saas/projects/lib/diff-utils.ts`.

### 2. Resolve where the save will resolve, not only at the end

The save resolves markers that reached a destination (`stripResidualDiffMarkers` in `@repo/utils/diff-markers`): a deleted run goes with its text and an added run keeps it. If only the save does this, a person approves one link and the save stores another. A deleted run can hide a different host in the userinfo, or split `javascript:` so the link rules pass it.

So resolve at the same layer the save reads:

- the diff inputs;
- `md.normalizeLink`, where raw or partly encoded markers first become percent-encoded;
- every markdown-it instance the review renders with, including the one for changed tables.

Make the resolver idempotent. Deleting a lone marker joins its neighbours and can reassemble a whole marker, so replace it with a character no marker contains instead. Then the review and the save, which resolve the same bytes once each, agree. `validateLink` refusing a destination that is not a fixed point remains as a fallback for that invariant.

### 3. Keep a repair inside one destination and linear

A resolver that runs on stored bodies, including on the server before any check can refuse, must not cross a destination boundary, and must not rescan from every unterminated start:

- a run holds no whitespace, parenthesis, bracket or angle bracket;
- a run never crosses another start marker.

Pin both with single-line timing tests.

### 4. On the server, normalize the stored side only

When the save repairs a body, a server check that compares the stored body with the saved one sees every repair as a change to an untouched section. Resolve the **stored** body the same way the save does before the comparison, and sign revision tokens over the resolved candidate. Compare the incoming body exactly as it arrives.

Making the comparison tolerant on both sides would let an injected marker run in an untouched URL pass the check.

Code: `reviewAiAcceptedSave` in `packages/api/modules/projects/lib/document-ai-review.ts`, and `revise-section.ts`.

## Why This Matters

A review is a promise that what the person sees is what will be stored. Every layer that rewrites the body after the review is a place where that promise can break silently. The tests pass, because each layer is right on its own. Resolving at one layer late, the save, made the backstop a way to change links after approval.

## When to Apply

- Any change to the diff renderer, the editor save, or a check that compares bodies across them.
- Any new invisible token, placeholder or escape that can travel through Markdown.

Test it through the real chain: diff, then `fromMarkdown`, then a TipTap editor with the document editor's extensions, then `getEditorMarkdownForSave`. Assert that the review's `href` list equals what the save stores, and that a temporary revert of the fix turns the test red.

## Related

- `docs/solutions/architecture-patterns/a-refused-ai-accept-must-be-reverted-not-left-dirty.md`: what the editor does when the server refuses an accept.
- `docs/solutions/security-issues/redos-in-preview-markdown-strip.md`: the timing-test shape for regexes on the streaming path.
- `docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md`: one vocabulary for the editor and the server; here, the marker tokens in `@repo/utils/diff-markers`.

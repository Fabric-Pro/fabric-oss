---
title: "A React node view without NodeViewContent shows its node's text"
date: 2026-10-27
category: ui-bugs
module: project-documents editor diagram node
problem_type: ui_bug
component: frontend
severity: high
applies_when:
  - "Writing a TipTap React node view (`ReactNodeViewRenderer`) for a node that has content, such as `content: \"text*\"`"
  - "A node view draws its own representation of the node's text (a diagram, tiles, a preview) instead of showing the text"
  - "Hiding a node's content element, or deciding where in a node view it goes"
  - "A node's text can carry AI-edit diff marks (`diffInsert`, `diffDelete`) while a change is under review"
tags: [tiptap, prosemirror, node-view, react, mermaid, diagrams, diff-review, ai-edit, fizzy-2946]
audience: engineers writing or changing a TipTap React node view in the document editor
owner: Fabric platform
---

# A React node view without NodeViewContent shows its node's text

## Context

The editor's mermaid node keeps a diagram's source as the node's text (`content: "text*"` in `apps/web/modules/saas/projects/lib/tiptap-mermaid-extension.tsx`) and its React node view draws the diagram from that text. The view rendered no `NodeViewContent`, because it shows the source in its own code editor when someone asks for it.

The result was reported from production: every diagram in every document had its full source printed as plain lines directly above the drawing. Nothing in the component rendered that text. TipTap put it there (Fizzy #2946, fixed in #1390).

The fix had a consequence that #1399 then had to handle. An AI edit under review marks its changes in the node's text. Once that text was hidden, the changes under review were hidden with it, and the diagram was drawn from the old and the new lines together.

## The rule

**A node with content always has its content element somewhere in the DOM. If the view does not say where, TipTap appends it to the node's own element, where it is visible.** So a React node view for a node with content must render `NodeViewContent` on every render path. That includes loading, error, code and side-by-side states. When the text must not be seen, render it inside a hidden holder. Do not leave it out.

## Why it happens

In `@tiptap/react` 3.31 (`node_modules/@tiptap/react/dist/index.js`, `ReactNodeView` in the `ReactNodeViewRenderer.tsx` region), the constructor of every non-leaf node view creates the content element and places it right away:

```js
const contentTarget = this.dom.querySelector("[data-node-view-content]");
if (contentTarget) contentTarget.appendChild(this.contentDOMElement);
else this.dom.appendChild(this.contentDOMElement);
```

When React later renders a `NodeViewContent`, its ref (`nodeViewContentRef`) moves the content element into it. With no `NodeViewContent` there is nothing to move it into, so it stays a direct child of the node's DOM, next to whatever the component drew. ProseMirror still needs the element, because it holds the node's text and maps positions into it. It is not something a node view can opt out of.

## How it is applied in code

`tiptap-mermaid-extension.tsx` has one component for the hidden case:

```tsx
function HiddenSource() {
	return <NodeViewContent className="hidden" aria-hidden="true" />;
}
```

Every render path that draws the diagram, or shows the source in its own editor, renders `<HiddenSource />` inside its `NodeViewWrapper`: the loading placeholder, the code/error view, and the drawn diagram in both its layouts (a Proposal's diagram menu and the default header bar). The side-by-side review panes use the same node view, so each pane's source is hidden too.

The review state is the exception. While the node's text carries a `diffInsert` or `diffDelete` mark (the node declares `marks: "diffInsert diffDelete"`), the text holds the removed and the added lines together. Drawn as one diagram, those lines make a picture that is neither version, and it can look plausible. While marks exist, the view:

- renders a **visible** `NodeViewContent` in a `div` under a "source under review" label, so the marks the review bar's Accept and Reject act on are in sight. It is a `div` and not a `pre` because the code block colours would make the deletion marks unreadable;
- draws the proposed version separately. `proposedSourceOf(node)` concatenates the node's text without the `diffDelete` ranges, and it returns `null` when nothing is marked, which is how the view knows a review is pending;
- shows no source editor and no menu, because their saves would write the mixed text back without its marks.

Once every change is accepted or rejected, the marks are gone, and the view goes back to drawing the diagram with the source hidden.

The stat tiles node (`tiptap-stat-tiles-extension.tsx`) is a sibling with the same shape. It always renders its `NodeViewContent` as a `pre` and clips it with `sr-only` while the source is closed, rather than leaving it out.

## How to test

Assert where the content element is, not only what the component draws. The element carries `data-node-view-content-react`.

- `apps/web/__tests__/modules/saas/projects/tiptap-mermaid-marker.test.tsx` ("a diagram's source text stays out of sight while the diagram is shown"): waits for the drawn SVG, finds `[data-node-view-content-react]` inside `.node-mermaidBlock`, and checks that its parent is not the node itself and is `hidden` and `aria-hidden="true"`. Without `HiddenSource`, the parent is the node.
- `apps/web/__tests__/modules/saas/projects/tiptap-mermaid-diff-review.test.tsx`: an AI edit under review shows its `del.diff-del` and `ins.diff-ins` marks in sight; the preview contains only the proposed version's labels; no render is ever called with old and new headers together; a proposed version that does not draw leaves the marked source on its own, with no error; Accept all and Reject all return the node to a drawn diagram with its source hidden; the side-by-side panes draw old and new each with their source hidden.

When adding a render path to a node view, add it to these tests. The bug comes back on whichever path forgets the content element.

## Related

- [a-new-node-type-in-a-shared-editor-is-deleted-by-the-previous-release.md](../architecture-patterns/a-new-node-type-in-a-shared-editor-is-deleted-by-the-previous-release.md): another constraint on node types in the same editor.
- [reconciling-a-human-edit-with-an-ai-rewrite-of-one-document.md](../architecture-patterns/reconciling-a-human-edit-with-an-ai-rewrite-of-one-document.md): how an AI rewrite is reviewed in the editor against a person's edits.
- [identity-inside-text-that-writers-replace-wholesale.md](../architecture-patterns/identity-inside-text-that-writers-replace-wholesale.md): the marker line that also lives in this node's text.

---
title: "A new node type in a shared editor is deleted by every client still on the previous release"
date: 2026-10-15
category: architecture-patterns
module: project-documents collaborative-editor
problem_type: architecture_pattern
component: frontend
severity: high
applies_when:
  - "Adding a TipTap node or mark to an extension set the collaborative (Yjs) document editor loads"
  - "Renaming or removing a node type that collaborative documents may already hold"
  - "Rolling back a web release that introduced a node type while collaboration is on"
tags: [tiptap, yjs, y-tiptap, collaborative-editing, schema-migration, rollout, rollback, stat-tiles, fizzy-2946]
related_components: [web-editor, collaboration]
audience: Engineers adding, renaming or removing editor node types in the project document editor
owner: Fabric platform
---

# A new node type in a shared editor is deleted by every client still on the previous release

## Context

The Proposal theme work (Fizzy #2946) added a `stat-tiles` block: a TipTap node that draws a fenced block as big-number tiles. The first version registered it in every project document editor, including the collaborative one built by `createCollaborativeExtensions` (`apps/web/modules/saas/projects/lib/tiptap-extensions.ts`). Review caught what that does during a rollout.

In the collaborative editor the document lives in a shared Y.Doc, not in markdown. Each client turns the Y.Doc's elements into ProseMirror nodes with its own schema. `@tiptap/y-tiptap` (3.0.9) does that in `createNodeFromYElement`, and when `schema.node(el.nodeName, …)` throws because the client's schema has no such node, the `catch` deletes the element from the shared document inside a Yjs transaction (the package's dist/y-tiptap.js, around lines 966–973 in 3.0.9):

```js
} catch (e) {
  // an error occured while creating the node. This is probably a result of a concurrent action.
  el.doc.transact((transaction) => {
    el._item.delete(transaction);
  }, ySyncPluginKey);
```

That deletion is an ordinary Yjs update, so it reaches every collaborator and the autosave persists it. One tab left open on the previous bundle during a deploy is enough: the first time it syncs a document holding the new node, the node is gone for everyone. A rollback does the same in reverse once newer clients have written the node.

## Guidance

Widen the schema of a shared editor in two releases, the way a database column is added before anything requires it:

1. **Release N** ships the node to editors that do not share a Y.Doc: the single-user document editor and read-only renderers such as the live sections. The collaborative extension set keeps the old schema. Content is not lost meanwhile, because the node's stored form is one the old schema already holds: a fenced code block that the shared editor shows as code and saves byte for byte.
2. **Release N+1**, once no client on release N−1 can still be connected, adds the node to the collaborative extension set.

Keep the stored form readable by the old schema. A fenced block with a language works because the code block node already exists everywhere. A node whose only form is its own element name has no safe intermediate state.

In this codebase the switch is the `statTiles` option on the shared extension builders (`apps/web/modules/saas/projects/lib/tiptap-extensions-advanced.ts`): `DocumentEditor` passes it to the single-user extensions and leaves it off for `createCollaborativeExtensions`, with a comment at that call explaining why.

## Why This Matters

The loss is silent and shared. No client errors, nothing is logged, and the person who wrote the block sees it vanish while the editor looks healthy. Tests do not catch it: every test runs a single schema, and the failure needs two bundles talking to one document.

## When to Apply

- Adding any node or mark to `buildSharedRichDocumentExtensions` or to what `createCollaborativeExtensions` returns.
- Renaming a node type: the old name is unknown to the new schema and the new name to the old, so a rename needs the same two steps, with both names accepted in between.
- Removing a node type: stop producing it first, keep it parseable for a release, then remove it.
- Before rolling back a release that added a node to the shared editor: check whether documents now hold it.

## Examples

The stat-tiles block (Fizzy #2946), as shipped:

| Surface | Release that adds the node | Stat-tiles fence shows as |
|---|---|---|
| Single-user document editor (client-document Proposal) | N | tiles |
| Live sections (read-only) | N | tiles |
| Collaborative document editor | N+1 | code block, kept byte for byte |
| Other editors and document types | not planned | code block |

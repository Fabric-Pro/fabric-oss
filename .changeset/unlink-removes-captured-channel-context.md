---
"fabric-app": patch
---

Unlinking a monitored Teams or Slack channel now deletes the context captured from it, together with its vectors

Fizzy #2228, U7. Unlink previously removed the monitor row and the seen-message
markers and stopped there. The channel's `ProjectContext` pointer row survived —
so an unlinked channel kept showing up as a project context — and every
conversation bundle captured under it survived with it, vectors included, so
retrieval kept answering from a channel the user had removed.

The three unlink procedures (`teams-channel-monitor`, `slack-channel-monitor`,
`teams-chat-monitor`) now read the monitor row's provider identity before
deleting it and route it through `deleteMonitoredConversationContext`
(`packages/temporal/src/lib/delete-channel-context.ts`), which is the other half
of the unlink protocol whose first half is the guard around the vector write in
`capture-conversation-bundle.ts`.

Ordering is the load-bearing part. The parent row is deleted FIRST, because its
absence is the state `parentStillLinked` reads: an embedder mid-flight then
either abandons before writing or deletes the point it just wrote. Delete the
vectors first and there is a window where an embedder writes after the filter
has run, sees a live parent, keeps the point, and strands conversation text in
the vector store of an unlinked channel. That window is pinned by a test that
lands an embed between the filter delete and the row delete.

Bundle ROWS cascade from the parent; bundle VECTORS do not, so the bundle ids are
read before the delete and handed to a filter afterwards. The filter uses only
indexed payload keys (`contextId`, `originalContextId`, `projectId`,
`organizationId`) — `parentContextId`, which the embedder writes as a grouping
key, carries no index and would be refused with a 400. The collection is
resolved with `getCollectionName`, never `ensureCollection`, so this cleanup path
cannot create the collection it is trying to delete from. A bundle's `qdrantId`
is deliberately not the mechanism: capture embeds asynchronously and
non-fatally, so a null `qdrantId` on a bundle that holds points is an ordinary
state, not an edge case.

A vector-store failure now fails the unlink instead of returning
`{ success: true }`, and the monitor row is left in place so the user sees a
failure they can retry. An unlink that finds no context row is a no-op, not an
error. Pending proposals are still retained on unlink — unchanged.

Tests: 14 added to `packages/temporal/__tests__/conversation-bundle-capture.test.ts`
(the deletion protocol, driven against an in-memory vector store that actually
applies the delete filter), and 27 across three new API test files, including the
first tests in `teams-chat-monitor/__tests__/`.

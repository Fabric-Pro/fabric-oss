---
"fabric-app": patch
---

A vector hit on a captured channel conversation now resolves to that conversation's text, so embedding one actually makes it retrievable

Fizzy #2228, U12. Retrieval uses the vector store as an index of ids and refetches
the text from Postgres, and that refetch resolved `ProjectContext` (falling back
to `ProjectContextUrlPage`) only. A captured conversation bundle is embedded
under its OWN `ProjectContextConversationBundle` row id, so every hit on one
resolved to null and was silently dropped — the capture unit's tests all passed
while the assistant could not cite a single monitored channel. R10 was unmet by a
path no capture-side test touches.

The point payload now carries `conversationBundleId` (and `parentContextId`, the
grouping key the embedder already believed it was writing). Both were being
dropped twice on the way in: `embedProjectContext` forwards a fixed subset of the
caller's metadata to `storeProjectContext`, which then builds an explicit payload
from a fixed key list. Both layers now pass them through, on the single-chunk and
the chunked path, and `searchSimilarProjectContexts` maps the marker back out.

Neither key is declared as a payload index, deliberately. They are read off the
search result and never filtered on — and only indexed keys may appear in a
delete-by-filter, which is why the channel-unlink delete reaches these same
points through the already-indexed `contextId` / `originalContextId` instead.
Adding an index here would have been harmless and pointless; declaring one and
then filtering on it in a collection created before the declaration is the bug
that shape invites.

`retrieveProjectContexts` branches on the marker and resolves through the new
`getRetrievableConversationBundleById`, which returns the same envelope the
context path returns — so the formatter, the effective-type mapping (the
channel's provider turns the row into `TEAMS_CHAT` / `SLACK_CHANNEL`) and every
downstream caller need no special case. Unlike the context resolver beside it,
this one is tenant-filtered: it is reached by row id alone, and a row id is not a
permission. A bundle whose row is gone resolves to null rather than throwing,
which is exactly the state an unlink leaves behind for as long as its vectors
linger.

The MCP `fabric_get_project_context` read gets the same treatment through
`getCapturedConversationMarkdown` — KTD7 names it as the one path no
retrieval-time guard covers. It needs none: capture applies
`neutralizeAiChatAttachmentBody` before the row write, so the text arrives
already guarded and is handed back byte-identical rather than passed through the
neutralizer a second time. A monitored channel with nothing captured still falls
back to its `unavailableReason`.

Tests: 7 in a new `retrieval-conversation-bundles.test.ts` (personal and
organization projects, an ordinary context point unchanged, a mixed result set,
two cross-tenant misses, and a deleted row under a lingering point — the database
resolver is mocked as a tenant-aware store so the cross-tenant cases miss for the
reason production would), 5 in a new `conversation-bundle-point-payload.test.ts`
pinning the marker's round trip through both dropping layers, 9 in a new
`retrievable-conversation-bundle.test.ts`, and 5 added to the MCP gateway suite.

Known gap, not addressed here: `listProjectContextSummaries` still derives
`contentAvailable` from the context row's own `content`, so
`fabric_list_project_contexts` reports `false` for a channel whose captured
conversation `fabric_get_project_context` will happily return. The reason string
was reworded to stay true on both paths. `retrieveRelevantContextsForSpec` shares
the old single-table refetch and still drops bundle hits — document generation,
not assistant retrieval, and out of this unit's scope.

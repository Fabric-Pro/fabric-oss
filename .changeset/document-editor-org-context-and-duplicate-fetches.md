---
"fabric-app": patch
---

Fix a mentioned user seeing "Document not found" inside an opened document, and stop each document open costing two identical fetches.

Fizzy #1187 was only half fixed. `DocumentEditorPage` was corrected to pass
`organizationId` into its `projects.documents.get` query so the fetch resolves
the org from the ROUTE rather than the viewer's session active-org — but that
page mounts `<DocumentEditor>`, which ran its own copy of the same query and
still omitted `organizationId`. For a viewer whose active org differs from the
route (the mentioned-user case the original ticket was about), the page-level
fetch succeeded while the nested editor's fell back to the wrong org and was
denied, so "Document not found" rendered inside an otherwise-loaded page.

The same omission also split one document across two React Query keys, so every
document open issued two identical ~40 KB round-trips. Passing `organizationId`
collapses them to one.

Adding the query's `enabled: orgContextReady` gate needed the loading test
widened to `isLoading || !orgContextReady`: a disabled query does not report
`isLoading`, so the guard would otherwise fall straight through to the
"Document not found" branch on every org-route load. This mirrors the combined
flag already used in `DocumentEditorPage`.

Changing the query key meant the four `documents.get.queryKey` builders inside
`DocumentEditorInner` had to carry `organizationId` too. `setQueryData` and
`getQueryData` match a key exactly — unlike `invalidateQueries` and
`cancelQueries`, which match by prefix — so leaving them unqualified would have
written the optimistic save into a cache entry nothing reads and made the
error rollback a silent no-op.

Separately, `useDefaultMcpInlineRender` now reuses its own in-flight
`/api/mcp-app/default-configs` request instead of issuing one per effect run.
React StrictMode runs every effect setup twice in development and the two runs
overlap, so this fired two identical requests on every mount. The reuse is
per-hook-instance rather than a realm-wide cache: the endpoint scopes its
response by session user as well as organization, so an org-keyed shared cache
could serve one user's configs to another if the account changed while a
request was in flight.

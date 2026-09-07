---
"fabric-app": patch
---

Fix every MCP tool call failing with a missing-scope error on the hosted `/mcp` server.

Scope enforcement shipped in the previous API-key change, and from that point every `tools/call` against the hosted MCP server was refused with `This API key does not have the "<scope>" scope required by <tool>` — for any key, holding any scopes. `initialize` kept succeeding, so it read as a provisioning problem and re-minting a key did not help.

`restoreAuthResult()` returns `scopes: []`, because the durable session has no scopes to carry, and the four callers that read a stored session wrote `storedAuthResult ?? authResult`. So a request quoting an `Mcp-Session-Id` ran with an empty scope set. Every `tools/call` carries that header; `initialize` does not and checks no scope, which is exactly the shape of the failure.

Identity and tenant now come from the stored session — the caller has already been matched against it — while the credential and its scopes are re-read from the request's own authentication, which is the only place they are true. The comment that previously asserted the opposite invariant has been corrected; it was the origin of the bug.

The failure was closed, not open: access was denied, nothing was exposed. `/api/mcp-gateway` was never affected, because it builds its session from the live authentication on every request — which is also why this survived verification, since that was the route the change was tested against.

Neither existing suite could have caught it: the route test mocks the tool executor so the scope check never runs, and the scope test builds a session directly so it never crosses the restore path. The new test drives the real route over two requests with the real executor, and fails with the reported error message when the fix is reverted.

Also removes a dead scope constant in the database package that had no importers, listed ten scopes where the procedure accepts twenty-two, and omitted `orgs:read` — the first thing anyone debugging a scope problem would find, pointing the wrong way.

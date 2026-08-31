---
"fabric-app": patch
---

The protocol server now verifies membership before honouring an organization named on a request

The hosted MCP server took the tenant for a request from a request header on the personal-API-key path and honoured it without checking that the caller belonged to that organization. The organization-key path was never affected — its tenant comes from the key record — and neither was the browser-session path, whose active organization is validated when the caller switches into it.

The check itself is one membership lookup. Expressing the refusal was the hard part. `authenticateRequest` returned `AuthResult | null`, and null already meant "no credentials, serve a public session"; every session path read a null fresh result as "keep using the stored session" and built the request session from `stored ?? fresh`. A refusal returned as null would have been swallowed and the caller served the tenant their session already carried, so the fix would have applied to new sessions only, for as long as a session lives. Authentication now returns three outcomes rather than two, and a refusal is fatal on every path that reads a session — not only the one that creates it.

The membership lookup moved into a shared query that the in-protocol switch tool also calls, so the two selectors cannot drift. Refusals are recorded in the audit ledger with a null organization, because the caller has no standing in the organization they named and the event must not appear in that organization's log.

Eleven tests, seven of which fail without the change. Fizzy #1875, Fabric bug 779.

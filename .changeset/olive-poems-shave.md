---
"fabric-app": patch
---

Fix Teams channel and chat monitors failing with a Microsoft Graph 401 by naming the Graph resource when refreshing a token.

Linked channels showed `Microsoft Graph API error: 401 Unauthorized —
InvalidAuthenticationToken, "Access token validation failure. Invalid audience."` on every
tick, and the built-in refresh-and-retry could not recover because it re-minted the same
wrong token.

Root cause: a Microsoft refresh token is multi-resource, and a redemption that omits `scope`
is issued against whichever resource was redeemed last. The channel-recording transcript
fallback deliberately takes a SharePoint-audience token (`<host>/.default`) and persists the
rotated refresh token onto the shared integration record; both Graph refresh sites then
redeemed it with no `scope`, so Graph received a SharePoint-audience token. The stored token
carried a full list of Graph scope names, which is why it looked correctly provisioned while
Graph rejected it — the audience was wrong, not the scopes.

Verified by decoding stored tokens (a subset held the SharePoint audience, the rest Graph) and
reproduced directly: redeeming for SharePoint and then redeeming with no `scope` returns a
SharePoint audience. Also confirmed the scope value pins the resource only and does not narrow
the grant — requesting a single scope still returns every consented one — so `.default` is
safe here.

Both refresh sites now send `scope=https://graph.microsoft.com/.default`. Affected connections
self-heal on the next refresh; no migration and no re-authorization needed.

Second, independent fix: the failure-state reset lived inside the cursor update, which the
monitor workflows call only when a tick finds new threads. A channel or chat that recovered
while quiet kept its error banner and its "please re-link this channel" prompt indefinitely.
Failure state is now cleared on any successful tick, gated with `patched()` so in-flight
workflow executions replay deterministically.

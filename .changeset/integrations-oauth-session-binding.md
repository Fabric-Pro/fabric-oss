---
"fabric-app": patch
---

Integration OAuth callbacks now belong to the session that started them, and a state can be redeemed once

The generic, GitHub and GitLab OAuth callbacks (`integrations.oauth.callback`,
`integrations.github.callback`, `integrations.gitlab.callback`) were public
procedures. Each decoded the HMAC-signed `state`, exchanged the code, and stored
the provider token under the `userId` and `organizationId` the state named. The
signature proved the flow had been STARTED by that user; nothing proved that the
browser now finishing it was theirs. An attacker could start a flow, take the
signed state from the authorize URL, and lure a victim into completing it — the
victim's provider token then landed in the attacker's account or organization.
`requirePermission(INTEGRATION_USE)` sat on the callback but has no tenant
context on a public procedure, so it returned early and checked nothing.

The provider redirects the user's own browser to the callback, so the request
already carries their session cookie. The callbacks are now `protectedProcedure`
and, after verifying the state, require that the session user IS `state.userId`
(FORBIDDEN otherwise) and, for an organization-scoped flow, that they still
belong to the organization the STATE names with a role that still grants
`INTEGRATION_USE` there — `start` checked that up to ten minutes earlier, and
both the membership and the role can have changed since. The callback's own
`requirePermission` evaluates the session's active organization, which need not
be the one in the state: a member of B demoted to viewer there, who switches
their session to A where they keep the permission, must not complete B's
callback, because the token it stores lands in B. The check reads the current
role in the target organization and refuses before the code is exchanged. The Next.js callback routes reach the API
through the server-side `orpcClient`, which forwards the incoming request's
headers, so the cookie arrives without a route change; the routes gained copy
for a refused session so a user who is signed out, or signed in as someone
else, is told what to do instead of seeing the bare error code.

The signed state carried a nonce and a ten-minute TTL but nothing remembered a
nonce once verified, so within the window one state redeemed as many codes as
could be obtained for it. Each callback now spends the nonce, atomically and
before the code exchange, through the Upstash client the rate limiter already
uses (`SET key NX EX ttl`). The MCP OAuth flow keeps its state in a table because
its rows carry a config and a server; the integration flow keeps its payload in
the signed token and only needs the nonce remembered, so a Redis key with the
state's own TTL is the whole requirement and no table was added. Fail-closed
follows `lib/rate-limit.ts`: in production a missing or failing Redis is a
refusal, never a pass; outside production an in-memory map keeps a fresh
checkout working unconfigured.

`start` also resolves the organization it signs into the state through
`resolveOrganizationIdForCaller`, the helper the rest of the plain-builder
handlers use, and now requires one: the three `start` procedures mount
`requireInputOrgPermission(INTEGRATION_USE, { requireOrganization: true })`, so
an explicit `organizationId: null` — which used to skip the role check and mint
a state whose callback stored an organization-less token — is refused before
the handler runs, and the handler refuses again (with the repo's
`MISSING_ORGANIZATION_CONTEXT` marker) before any state is minted, so the signed
organization is always a string. Integration OAuth has no personal arm under
ADR-018. `requireInputOrgPermission` on `start` already refused a
non-member; the change makes the signed value the authorized value by
construction rather than by two resolvers agreeing, and gives the GitLab
credential lookup the same resolved value instead of a separately derived one.

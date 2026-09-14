---
"fabric-app": patch
---

Revoked API keys stay revoked, key deletion is gated and recorded, and offboarding retires the keys a departing member minted

Fizzy #2380, QA round 2. Four independent lifecycle gaps, all found by the
end-to-end credential audit rather than by the card's own acceptance criteria —
which is the point worth keeping: AC2 as written ("the key is scoped to the
projects the user can already reach") could not have caught any of them.

`audit.apiKeys.rotate` reinstated a revoked key. Revocation is a soft flag and
rotate wrote `isActive: true` alongside the new hash; the where-clause did not
even select `isActive`, so no guard was possible downstream. Revoke a key,
confirm it dead, rotate it, and a working secret came back with no create step
and nothing recording that the credential had returned. Both branches now
refuse with `CONFLICT` rather than `NOT_FOUND` — the row genuinely exists, and
saying so is what tells an operator the revocation stands.

`DELETE /api/v1/auth/keys/:id` carried no scope check while its GET and POST
siblings gate on `keys:read` and `keys:write`, and the only app-level
middleware is authentication and rate limiting. Any key of the caller's —
including one holding nothing but `orgs:read` — could retire their others. It
was also a hard delete despite its own docstring calling it a revoke,
discarding the forensic row. Now gated and soft, which is observably identical
from a client's side: `verifyUserApiKey` refuses an inactive key and
`listUserApiKeys` hides one unless asked.

A member could mint a wildcard organization key by calling the create
procedure directly; the settings picker deliberately never offered it. Every
other scope in that vocabulary names something the minting role already holds
— the premise that lets `maxScopesForRole` clamp only the viewer role — and
`"*"` was the single entry that broke it. Removed from the vocabulary, so no
role can mint one. Keys already issued keep working: `hasScope` and
`scopeSatisfied` test the stored string at request time and never consult that
list, and narrowing at the consumption end would silently strip every MCP
scope from every wildcard key, which is the regression the restored-session
fix had to undo.

Offboarding now deactivates the keys the departing member minted. Removal used
to retire a key only where the verifier re-reads membership live;
`verifyOrganizationApiKey` does, but the runtime verifier, `/mcp`, the
fabric-kanban routes, agent model resolution and readiness evidence all gate on
`isActive` alone and never ask whether the creator is still a member, so an
offboarded creator's key kept authenticating there. Added at the single seam
both exits reach — removed and left — following that helper's contract of one
statement per table, no reads, and a predicate scoped to the one organization.
`isActive: false` is terminal, so re-inviting someone does not put their old
secret back in circulation.

Demotion is deliberately not hooked: `OWNER_PERMISSION_GATES` re-checks the
owner's current role per request, and deactivating on a role change would
destroy keys that are still legitimate.

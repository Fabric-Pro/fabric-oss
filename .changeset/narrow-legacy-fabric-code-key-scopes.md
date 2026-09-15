---
"fabric-app": patch
---

Narrow the Fabric Code extension keys issued before the mint was scoped, so they no longer act as full-access credentials.

Fizzy #2380 follow-up. The commit that scoped `/vscode-auth/approve` changed the mint from
`["*"]` to `["mcp:read","mcp:write"]` and shipped no data migration, so keys issued by that
path beforehand still carry the wildcard. `verifyUserApiKey` treats `"*"` as satisfying any
required scope — deliberately, so those keys kept working when the Fabric Code routes started
requiring one — which left a credential obtainable on a single click, by any member regardless
of org role, reaching every scoped surface in the product.

The migration is keyed on the mint's own key name as well as the wildcard. `["mcp:read",
"mcp:write"]` is the right replacement for exactly one reason — it is what that path issues
today, so a narrowed key is indistinguishable from a fresh one and the extension notices
nothing. That reasoning does not carry to a wildcard key minted some other way, so the
predicate declines to touch one rather than guessing at what its holder needed.

Sized against production before writing: two matching rows, both holding a single-element
`{*}`, both belonging to one user, neither used in over four months, and no wildcard key of any
other name. Staging holds none at all, which is why this could not be rehearsed there — it was
rehearsed instead against a throwaway Postgres seeded with all five shapes (wildcard active,
wildcard revoked, already-narrow, wildcard under another name, ordinary scoped key). Only the
first two changed, the other-named wildcard was declined, and a second apply reported
`UPDATE 0`.

Narrowing rather than revoking is a deliberate choice: revoking would also close the gap and be
more visible, but these keys are dormant rather than abandoned and never expire, so narrowing
leaves a working key that reaches exactly what the extension needs.

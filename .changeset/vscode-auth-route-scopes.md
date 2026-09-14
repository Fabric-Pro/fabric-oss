---
"fabric-app": patch
---

The Fabric Code routes now require a scope, and a personal key's wildcard is honoured the way an organization key's already was

Fizzy #2380, QA round 2, the last surface in the product that read no scopes at
all. `authFromBearer` called `verifyUserApiKey` with one argument. That
function's scope check is guarded by its own optional parameter, so passing
nothing skips it entirely — every route in the module accepted any valid `fab_`
key, whatever it had been issued to do. The audit reached `/profile`,
`/profile/balance`, `/defaults` and `/openrouter/models` with a key holding
unrelated scopes.

Low impact taken alone: three of those answer from constants and `/profile`
returns only the caller's own identity and organization list. The shape is the
problem rather than the blast radius, and it is easy to reintroduce, since
deleting an argument at a call site reads like a tightening.

The five read routes now require `mcp:read` and the completion route requires
`mcp:write` — exactly the two scopes the key minted by `/vscode-auth/approve`
already carries, so the extension is unaffected. The completion route also
stops duplicating the bearer parsing inline and goes through the same helper.

`verifyUserApiKey` now treats `"*"` as satisfying any scope, matching `hasScope`
for organization keys. Without that the two verifiers disagreed about the same
stored string, and personal keys minted before the Fabric Code key was narrowed
— which carry `["*"]` and nothing else — would have been refused by every newly
scoped route. No existing caller changes behaviour: every other call site passes
no scope and does its own checking downstream.

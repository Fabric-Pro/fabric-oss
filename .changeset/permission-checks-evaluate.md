---
"fabric-app": patch
---

Make twenty-nine permission checks actually evaluate, against the organization the handler acts on

Each of these declared a `requirePermission(...)` on a builder that supplies no tenant context, so the middleware returned `next()` unconditionally: the call read as a role check, reviewed as a role check, and enforced nothing. Nineteen were the weave procedures, the rest the agent registry, the agent trigger and MCP authority.

They now use `requireInputOrgPermission`, which resolves the same organization the handler resolves from input and checks the caller's role in that one. Moving them to the tenant-aware builder would have been worse than leaving them: it derives the tenant from the session, so an owner of one organization could have passed another and satisfied the check with the wrong role.

Two consequences worth knowing before release: a viewer can no longer approve plans or start executions, which is the intent of the permissions as declared; and cancelling an execution or deleting a plan declares `AGENT_DELETE`, which is admin and above, so an ordinary member who started a run can no longer cancel it. That tier is what the code already said — whether cancellation belongs at it is a product call, flagged rather than changed here.

The sweep's pending list is now empty and its ratchet holds it there. The separate input-org verification baseline drops from 325 to 324.

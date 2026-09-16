---
"fabric-app": patch
---

Deleting a system prompt now resolves the workspace itself when the session names none and the answer is unambiguous, instead of refusing.

QA reported being unable to delete a system prompt "in personal workspace"
while the same account could inside an organization. The authority for a
SYSTEM prompt is the GLOBAL platform role, which does not vary by
organization — so the organization was never what differed. The tenant context
was. `tenantContextMiddleware` builds one from `session.activeOrganizationId`
and nothing else, and that pointer is routinely empty on a request whose page
sits inside one organization: the signed session cookie is a rolling five-minute
snapshot that a Prisma write cannot refresh, the client-side alignment that can
refresh it runs once per organization and is deliberately not retried after a
refusal, and a bare `/app` load resolves no organization at all by design.

`resolveUnambiguousOrganization` answers that case with the rule sign-in
already uses — `resolveUserOrganization`: the single membership, or the
last-active one while it is still a membership. An account with several
memberships and no last-active still resolves to nothing and is still refused;
placing someone in a tenant nobody named is the failure this is careful not to
introduce.

Three placement decisions carry the safety:

- Opt-in per procedure, not inside `tenantContextMiddleware`. That middleware's
  empty arm is legitimately reached by account-global procedures, whose tenant
  filter is `{ organizationId: null, userId }`; filling an organization in
  there would silently narrow what their callers see across the application.
- Before `requirePermission`, not inside the handler. That middleware returns
  `next()` without evaluating any role when the tenant context is absent or
  personal, so a handler resolving its own organization afterwards would have
  been waved through the permission gate first.
- Re-enters `runWithTenantContext`. `getTenantDb()` reads the AsyncLocalStorage
  store rather than `context.tenantContext`, so handing the chain an
  organization context without re-entering would leave auto-filtered queries
  scoped to the personal arm while the handler believed otherwise.

The new suite drives the middleware's own output into the real permission
middleware and asserts a plain member is denied — the assertion that
distinguishes "resolved an organization" from "skipped the role check", which
shape assertions alone cannot.

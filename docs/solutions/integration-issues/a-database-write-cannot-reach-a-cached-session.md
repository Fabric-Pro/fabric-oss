---
title: "A database write cannot reach a cached session"
date: 2026-09-04
category: integration-issues
module: auth api web session
problem_type: integration_issue
component: full_stack
severity: high
symptoms:
  - "A page renders one organization while API calls made from it resolve against another"
  - "A session field written with Prisma has no effect on the next oRPC request, then works minutes later"
  - "A tenant-context change appears correct in a server component and stale in a procedure"
root_cause: "Better Auth serves the session from a signed session_data cookie for up to five minutes; a direct database write to the session row does not invalidate it, and only the web getSession opts out of that cache"
resolution_type: workaround
applies_when:
  - "Writing session.activeOrganizationId, or any session field, outside Better Auth's own API"
  - "Reasoning about what a procedure will see after a server component changes session state"
  - "A fix looks correct in the database and has no observable effect"
tags: [better-auth, session, cookie-cache, tenant-context, orpc, server-components, disable-cookie-cache]
related_components: [auth, api-procedures, tenant-context-middleware, active-organization-provider]
audience: engineers changing session state outside Better Auth
owner: platform team
---

## Problem

The post-login redirect was changed to send a user to the workspace they last
worked in. Because `tenantContextMiddleware` builds the oRPC tenant context from
`session.activeOrganizationId`, the redirect also wrote that field, so the API
would follow the URL rather than resolving against whatever organization the
session still named.

The write landed in the database. The API did not see it.

## Symptoms

- The page renders organization B; oRPC calls made from that page resolve
  against organization A for up to five minutes, then silently start working.
- A unit test asserting `db.session.update` was called passes. The behaviour it
  was written to guarantee does not happen.
- The same `getSession` name behaves differently depending on which layer calls
  it, with no type or lint signal that they differ.

## What Didn't Work

**Writing the session row directly.** This is the intuitive fix and the one that
looks correct in the database:

```ts
await db.session.update({
    where: { id: session.session.id },
    data: { activeOrganizationId: targetOrganization.id },
});
redirect(`/app/${targetOrganization.slug}`);
```

**Setting `cookieCache.version` to a function of the session.** The version
callback is invoked with the *cached* session on read, not a fresh one
(`better-auth/dist/api/routes/session.mjs`), so it can express schema versioning
but cannot detect that the row has drifted from the cookie.

**Calling `auth.api.setActiveOrganization` from the server component.** It is the
right API — it calls `setSessionCookie`, which calls `setCookieCache` — but a
Next.js Server Component cannot set cookies, so the refreshed cookie never
reaches the browser.

## Solution

Reconcile from the client, using the same call the workspace switcher already
makes. `authClient.organization.setActive` updates the row *and* refreshes the
cookie cache, because it runs where a `Set-Cookie` can actually be emitted:

```ts
useEffect(() => {
    if (!activeOrganization || switchTarget || switchInFlightRef.current) return;
    if (session?.activeOrganizationId === activeOrganization.id) return;
    if (reconciledOrganizationsRef.current.has(activeOrganization.id)) return;
    reconciledOrganizationsRef.current.add(activeOrganization.id);

    void authClient.organization
        .setActive({ organizationId: activeOrganization.id })
        .then(({ error }) => {
            if (error) throw error;
            queryClient.setQueryData(sessionQueryKey, (data: any) => ({
                ...data,
                session: { ...data?.session, activeOrganizationId: activeOrganization.id },
            }));
        })
        .catch(/* log; never toast, never navigate */);
}, [activeOrganization, session?.activeOrganizationId, switchTarget, queryClient]);
```

Three guards, each load-bearing: skip when the two already agree, skip during an
in-flight switch, and record the attempt so a refusal is not retried on every
render. Updating the cached session on success is what lets the effect settle
instead of re-firing.

## Why This Works

`setCookieCache` stores `filterOutputFields(session.session, …)` — the whole
session row, including `activeOrganizationId` — in a signed cookie with
`maxAge: 5 * 60`. Nothing in Prisma's write path knows that cookie exists.

The trap is that the two readers disagree and look identical at the call site:

| Caller | Reads |
|---|---|
| `apps/web/modules/saas/auth/lib/server.ts` — `getSession` | `disableCookieCache: true` -> the **database** |
| `packages/api/orpc/procedures.ts` — `protectedProcedure` | no flag -> the **signed cookie**, up to five minutes stale |

So a server component sees the write immediately and concludes the fix works.
The API does not. Both call something named `getSession`.

Worth noting what the fix does *not* claim: most oRPC calls pass an explicit,
URL-derived `organizationId`, and `resolveOrganizationId` prefers that over the
session. The exposure is calls that pass nothing and fall back to the session.
That is why the impact is real but not catastrophic, and why no test caught it.

## Prevention

**Any change to session state outside Better Auth's own API must say how the
cookie cache learns about it.** In practice:

- Prefer `auth.api.*` / `authClient.*` over a direct write to the `session`
  table. They own the cookie.
- A Server Component cannot set cookies. If the change must be visible to the
  API on the *next* request, it belongs in a Route Handler, a Server Action, or
  the client.
- When you must write the row directly, treat it as eventually-consistent from
  the API's point of view and say so in a comment at the write.

**Test the observable effect, not the call.** The test here asserted
`db.session.update` was invoked, which is true and proves nothing:

```ts
// Passes whether or not the API can see the change.
expect(db.session.update).toHaveBeenCalledWith(/* … */);
```

An honest assertion has to go through the reader that matters — the session as
`protectedProcedure` resolves it — or, failing that, the test file should record
in a comment that it pins the write and not its visibility, so the next reader
does not mistake one for the other.

## Related

- [Removing a fallback promotes every path that relied on it](../architecture-patterns/removing-a-fallback-promotes-every-path-that-relied-on-it.md) — the other half of the same branch
- [Where a sign-in decides which organization to open](../post-login-organization-resolution.md) — the redirect ordering this write belongs to, including the residual risks
- `docs/adr/018-organization-is-the-only-tenant-context.md` — why a session with no organization is a fail-closed default rather than personal context

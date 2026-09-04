---
"fabric-app": patch
---

Signing in now returns you to the workspace you last worked in, instead of whichever organization the session or the query happened to name.

The post-login hop at `apps/web/app/(saas)/app/(account)/page.tsx` had two branches
and only ever took the first. It preferred `session.activeOrganizationId`, falling
back to `organizations[0]`; the branch that consults the durable
`user.lastActiveOrganizationId` sat behind it and was reached only when the session
carried no organization at all.

Two things made that land in the wrong place:

- A multi-organization user whose last-active pointer is unset or names an
  organization they have left makes `resolveUserOrganization` return `ambiguous`,
  so the session is seeded with nothing and the page falls through to
  `organizations[0]`. Better Auth's `listOrganizations` issues a `findMany` on
  `member` with no sort, so that index is not stable between two logins.
- The workspace switcher persisted `lastActiveOrganizationId` fire-and-forget
  behind an empty `.catch()`. A single failed request silently discarded the only
  durable record of where the person was working, and because session seeding
  derives from that field, the next sign-in opened the organization they had
  switched away from — with no error and no log.

The order is now last-active first, session second, membership list last, and it
stays inside the `?postLogin=1` guard so a bare `/app` load is untouched
(multi-tab refresh safety, #1477). The redirect also aligns
`session.activeOrganizationId` with the organization it sends the user into:
`tenantContextMiddleware` builds the oRPC tenant context from that field, so
redirecting on last-active without writing the session would have put the URL in
one organization and every API call in another. The alignment write is
best-effort and never blocks the redirect.

---
"fabric-app": patch
---

Give every session the organization it runs in, and refuse a request that resolves to none

`activeOrganizationId` was written only by an explicit organization switch, so a user who signed in and never switched carried none — read off the session rows of a running deployment. Everything that falls back to that field therefore fell back to nothing, and with personal context gone, nothing means nowhere.

That was the last way past the permission checks: an explicit `organizationId: null` resolves to no organization and deliberately does not fall back to the session, so the middleware took its pass-through branch and the role was never examined. With the session carrying an organization, refusing that case no longer refuses the caller who simply omits it, so the sixteen org-scoped call sites now do refuse it.

The seeding is fail-closed and is a default rather than a context authority: it resolves an organization only when the choice is unambiguous, never overwrites a session that already names one, and never blocks a sign-in if it fails. Organization context stays URL-driven, which is what keeps two browser tabs from fighting over this single last-write-wins value.

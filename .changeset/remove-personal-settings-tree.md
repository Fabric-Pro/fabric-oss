---
"fabric-app": patch
---

The personal settings tree is gone

Twenty-one routes under `/app/settings/**` are replaced by one catch-all that redirects into the caller's organization. A catch-all rather than twenty-one redirect stubs, because a stub keeps its route and its layout alive, which is the thing being removed. Bookmarks, emailed links and OAuth callbacks all still arrive somewhere valid, query strings included — the two-factor enforcement redirect depends on carrying `mfaRequired` through.

Four of the pages are account-global rather than personal — a profile, account security, notification preferences and account deletion — and moved to `settings/account/*` inside the organization rather than merging by slug. Two of them would have collided outright: `general` is a profile on one side and an organization's settings on the other, and `danger-zone` deletes an account on one side and an organization on the other. That second collision is why a slug-for-slug redirect was not available — a bookmark to delete an account would have landed on the page that deletes the organization.

Two-factor enforcement no longer pushes a member out of the organization enforcing it: the redirect and the setup banner both point inside now, since account security has a home there.

The remaining seventeen keep their slug. Their personal-context data is being dropped, so the organization's page of the same name is the only one left to show.

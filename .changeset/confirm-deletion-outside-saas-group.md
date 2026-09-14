---
"fabric-app": patch
---

Keep the emailed organization-deletion link working when opened from a signed-out browser

The confirmation page lived inside the `(saas)` route group, whose layout redirects a visitor with no session to a bare `/auth/login` — discarding the `?token=` the emailed link carries. That layout runs before the page, so the page's own redirect, which preserves the token, could never fire. An owner who opened the link on a device they were not already signed in on was sent to a login screen and then to `/app`, with no way back to the confirmation.

The page now sits at `app/organizations/confirm-deletion/`, alongside every other emailed landing page (`organization-invitation`, `project-invitation`, `unsubscribe`, `newsletter/confirm`), with its own layout supplying intl, session and `AuthWrapper`. The query client is already global, so nothing else was needed. The URL is unchanged.

Guarded by a new assertion in `__tests__/middleware/proxy.test.ts`: any emailed link that attaches a search param must not resolve under `(saas)`. `/app` is exempt (the proxy sends it to a login that does carry `redirectTo`), and links with no query are exempt. It fails if the page is moved back.

---
"fabric-app": patch
---

The workspace switcher no longer names a personal account on the shell that `/app` paints on its way into an organization.

Follow-up to the hydration fix: that one removed the flash on pages that name an
organization, and this one removes it on the pages that name none.

Signing in showed "Your account" in the sidebar for a few hundred milliseconds
before the organization appeared. `redirectAfterSignIn` is `/app?postLogin=1`
and `LoginForm` reaches it with `router.replace` — a CLIENT navigation, so the
router commits the URL and paints the account group's layouts while the page
streams. Only the page redirects; the layouts do not. The shell therefore
renders with no organization in the URL at all, which the switcher read as
"personal account" rather than "in transit".

Measured on a deployed build by sampling the DOM across the whole login
navigation: the shell rendered at `/app?postLogin=1` at t+1261ms carrying "Your
account", and the organization replaced it at t+1710ms — a 450ms window.

With `requireOrganization` on there is nothing under `/app` to rest on: `/app`
itself redirects on every branch, the sixteen retired account routes are
redirect stubs, and the one remaining rendering page calls `notFound()`. So the
account presentation there is never a resting state, and the switcher now holds
its skeleton instead. Gated on `requireOrganization`, so a deployment where
organizations are optional keeps the personal presentation `/app` legitimately
rests in — pinned by its own test.

Keyed on the URL's own `organizationSlug` rather than on the resolved
organization: a page that DOES name one can still fall through to the account
presentation if its query fails, instead of holding a skeleton that never
resolves.

Also adds `useParams` to the global `next/navigation` test mock, which had only
`useRouter`/`usePathname`/`useSearchParams`.

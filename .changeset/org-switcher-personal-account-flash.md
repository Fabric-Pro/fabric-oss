---
"fabric-app": patch
---

The organization a page resolved on the server now reaches the browser, so the workspace switcher no longer flashes "Your account" on load.

Loading `/app/{slug}/…` briefly showed the sidebar switcher naming a personal
account while the breadcrumbs already named the organization — same
organization, two resolution paths, only one of them seeded.

Two defects, both fixed:

1. `[organizationSlug]/layout.tsx` prefetched the active organization into the
   request-scoped query client but had no `<HydrationBoundary>` of its own. The
   only boundary is in the parent `(saas)/layout.tsx`, which builds its
   dehydration snapshot while constructing its JSX — before the child layout
   runs. Every prefetch made in the org layout therefore landed in the cache
   after that snapshot was sealed and never shipped, so the client started cold
   and refetched an organization the server already had in hand. Fixed with a
   nested boundary, the same shape `admin/organizations/[id]/page.tsx` uses.
   This also un-wastes the org-scoped purchases prefetch alongside it.

2. `OrganizationSelect` treated a null organization as "personal account"
   rather than "not resolved yet". With `requireOrganization` on there is no
   personal context left to fall back to (ADR-018), so that branch is not a
   resting state on these pages — reaching it means the data has not arrived,
   and the label asserted something false about the viewer's identity. The
   switcher now holds its existing skeleton instead. Gated on the query's
   `isLoading` rather than the context's `loaded`, which never flips back after
   a failed fetch and would have stranded the switcher in a permanent skeleton;
   and suppressed during a workspace switch, which has its own optimistic
   presentation.

Tests: `__tests__/app/organization-layout-hydration.test.tsx` pins the handover
(a client consumer has the organization on first render, with no fetch);
`OrganizationSelect.test.tsx` gains two cases separating "still resolving" from
"no organization". Full web suite green (10407 tests).

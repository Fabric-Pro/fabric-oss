---
"fabric-app": patch
---

Fix the emailed organization-deletion confirmation link landing on a 404 instead of the confirmation page

The link mailed by the deletion request (Fizzy #2462) pointed at
`/organizations/confirm-deletion`, which was missing from `pathsWithoutLocale` in
`apps/web/proxy.ts`. Any path not listed there falls through to the next-intl
middleware, which localizes it to `/en/...`, matches no marketing route and
renders the marketing 404 — while the route file itself sits correctly in the
build, so the failure reads as a bad deploy rather than a missing entry.

The effect was that the whole flow was unusable end to end on a deployed
environment: an owner could request a deletion and never confirm one. The
30-day reminder email was unaffected — it points at `/new-organization`, which
is listed.

This is the third time the same omission has shipped, after `/unsubscribe` and
`/newsletter/confirm`, and the second time it shipped despite a comment in the
list warning about exactly it. So the list is now module-scope and exported, and
`__tests__/middleware/proxy.test.ts` scans `packages/api` and `packages/temporal`
for every `new URL(<path>, getBaseUrl())` the server builds and asserts the proxy
will serve it — resolving named constants, and failing if the scan itself ever
stops matching. Both new tests fail against the unfixed proxy.

---
"fabric-app": patch
---

Close two gaps found in review: a user-facing AI path that could still reach the platform key, and a post-login redirect the API could not see.

Both were found by the code review on this branch, and both defeated a claim the
branch makes rather than being incidental.

`resolveModelWithProvider` picks its resolver by task type, and the generation
branch says the platform gateway key is "structurally out of reach here". It was
not. When model selection lands on a provider the tenant has not configured, the
function makes a second lookup through `getAiProviderApiKeyByProvider` — which is
deliberately unsplit, refuses in organization context, and ends its personal
branch at the gateway. The call site passes `context.organizationId || undefined`,
so a falsy organization id reached that branch, and after the org-only
elimination a falsy organization id means something failed to resolve one rather
than that the caller is working personally. The generation path now refuses a
config whose `source` is unset, which is exactly the platform-served shape and
nothing else. No carve-out is needed for embedding: a provider mismatch there
returns at a fatal check before the fallback, which is now pinned by a test so it
cannot quietly stop being true.

The post-login hop wrote `session.activeOrganizationId` with Prisma so the oRPC
tenant context would follow the URL. It could not: `protectedProcedure` reads the
session through Better Auth's signed `session_data` cookie, a five-minute
snapshot no database write can touch, so the page rendered one organization while
calls that fall back to the session resolved against another. Only something that
can set cookies closes that, which a Server Component cannot — so the client now
reconciles through the same `setActive` the workspace switcher uses, refreshing
the cookie cache and the row together. That also covers a bare /app load, which
redirects into the first membership and previously wrote nothing at all.

Both guards are mutation-tested: removing either fails exactly one test.

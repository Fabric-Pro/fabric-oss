---
"fabric-app": patch
---

The duplicate check now gives up after a fixed time so creating a work item never waits on a slow AI provider.

Fizzy #2180 post-ship fix. The previous timeout only bounded the language-judge call; the typed decision fast path (its own 10s timeout plus a retry) and the embedding call ahead of it had no bound at all, so a stalled provider could leave the roadmap "Add" dialog on "Checking for similar work items…" until the platform's own function timeout, blocking creation the whole time. `packages/temporal/src/lib/backlog-routing-core.ts` now threads an optional `abortSignal` through `loadRoutingCorpus` (forwarded to the embedding call) and combines it with the decision fast path's own timeout via `AbortSignal.any`. `check-duplicate.ts` creates ONE request deadline (`DUPLICATE_CHECK_TIMEOUT_MS`, default 20s, env-overridable) right after the auth check and races the whole embed-and-judge pipeline against it, returning the existing "could not check" result on expiry. The web call now also carries a client-side abort (30s) as a backstop ahead of that.

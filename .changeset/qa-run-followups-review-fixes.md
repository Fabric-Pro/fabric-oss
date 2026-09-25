---
"fabric-app": patch
---

Scripted URL assertions no longer record query or fragment values, and a blocked navigation now says which side to check only when it can tell.

Post-ship review of the QA-003 run follow-ups (Fizzy #2232–#2235):

- `assertUrl` failures record origin, path and query parameter names only, with every value and any fragment masked. The page URL after a sign-in step is routinely an OAuth/SSO callback, and this message is persisted, shown to project readers, sent to the RCA model and copied into bug bodies. When the two URLs differ only in masked values, the message says so.
- A failed proxied fetch in the Agentic runner is classified by its error code: connection refused, host not found and an unverifiable certificate point at the environment; timeouts, resets and other network failures name both possible sides instead of stating "not your environment".
- Run dialog: keyboard focus moves to Back on the confirm step and back to Start on return (it was dropped to the page body); Start waits for the quote so the confirm step always has a figure; Confirm is disabled over the cap; the closed Runner picker shows the runner's name only (the cost suffix truncated it); the footer figure is an `aria-live` region.

---
"fabric-app": patch
---

Browser-automation sessions now verify the calling user owns the session before navigating, extracting, screenshotting or closing it.

`getSession` in the browser-automation session manager was a bare map lookup: the
file documented isolation by user and organization, but every activity input
carried only `sessionId`, so naming an id was enough to drive the session behind
it. The CSPRNG session id landed earlier closed the guessing window; this closes
the design gap behind it.

`userId`/`organizationId` are now threaded through the six activity inputs
(`NavigateInput`, `ExecuteActionInput`, `ExtractContentInput`,
`TakeScreenshotInput`, `AuthenticateInput`, `CloseBrowserSessionInput`) and
checked against the session's recorded owner. `userId` is deliberately required
rather than optional, so the compiler enumerates every call site instead of
letting one silently skip the check.

The check is per-user, not per-organization. `sessionScope()` collapses to
`org:<id>` whenever an organization is present, so comparing scope strings would
have let any colleague in the same organization drive another person's live
browser — which holds that person's authenticated third-party cookies. A
mismatch returns the same "not found" value a missing session does, rather than a
distinct error that would act as an existence oracle, and is logged as a security
event.

`closeSession` and `getStorageState` are guarded too, not just `getSession`: the
former is a cross-tenant denial of service, the latter returns cookies and
localStorage outright. Worker shutdown and the expiry sweep close sessions
through an internal unchecked path, since neither acts for a caller.

Workflow changes are argument threading only — no activity call, sleep or branch
was added, removed or reordered, so recorded histories still replay.

---
"fabric-app": patch
---

Credit the people who actually wrote the code a publishing topic is about

PR authorship is the only signal that identifies who *built* the thing being written about, and the only one with an unambiguous identity key rather than a name match. It was resolving through the wrong table (Fizzy #1851, defect §1c).

`Account(providerId: "github")` is written by exactly one thing: Better Auth social sign-in — someone clicking "Sign in with GitHub". That is not how Fabric learns a GitHub identity. Connecting a repository runs a separate OAuth flow that writes `WorkflowIntegration.settings.githubUserId`, and a project cannot have PRs in its suggestion context unless somebody completed that flow. So the join was keyed to a login *method* instead of to the connection the product actually creates: **2 identities against 12** in production, and on staging only **12 of 202 topics (6%)** resolved any contributor at all.

Both sources are now consulted, scoped to the project's own organization so the read cannot grow without bound and cannot credit somebody outside the tenant. The comparison is done on strings because GitHub sends the id as a number and the column it lands in is untyped JSON — a `===` between them matches nothing, which looks exactly like "no such contributor".

FR-A6's fail-closed rule is unchanged and now spans both sources: a GitHub id reachable as two different Fabric users credits nobody, however it was reached. A failure reading the integrations still leaves the story and document contributors intact.

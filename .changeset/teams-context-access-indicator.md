---
"fabric-app": patch
---

Show when a linked Teams chat can't be read by the current user, so it's clear it won't be used as context for them.

A linked Teams chat/channel is read under the VIEWING user's own Microsoft
Graph token — access is per-user, not per-project. When Graph returned a 403
for one member (e.g. removed from the chat), nothing in the UI said so: the
row in the project's Context tab rendered like a healthy one, and that
member's document editor / story workspace / RAG reads silently got nothing
from it. The 403 was also logged at `console.error` on every read, adding
noise to prod error-monitoring for a per-viewer condition, not a fault
(Fizzy #2450).

Adds `integrations.teams.contextAccess`, which probes each Teams context
linked to a project with the caller's own credentials (the same Graph calls
the real read makes, capped to one message) and reports per-context
readability keyed by the ProjectContext row id. The Context tab's Teams
Chats row now shows an inline "Not readable by you" indicator (with the
error in a tooltip) when the current viewer can't read that context; other
viewers with access see nothing. This is per-viewer, in-memory state only —
no persisted health column, no schema change, no notification — and never
feeds into the project's readiness tallies.

Downgrades the four Teams read sites (`getRecentMessages`,
`live-integration-context`, and both `search-project-teams-messages`
activities) from `console.error` to `console.warn` when the caught error is
a Graph 403, via a new `isMicrosoftAccessDeniedError` classifier alongside
the existing not-connected one.

`packages/temporal/src/activities/__tests__/search-project-teams-messages.test.ts`
needed its `@repo/integrations/microsoft` mock extended to re-export the new
classifier from the real module (mirroring how it already does for
`isMicrosoftNotConnectedError`) — the log-level fix made the source import
it, and the existing "genuine 500 still logs at error" case is unaffected
since a 500 doesn't match the new classifier.

Review fixes (same PR): the probe now resolves Graph credentials from the
PROJECT's own stored organizationId (`getProjectAccessContext`), never the
caller-supplied input value, and is gated by `requireProjectPermission(CONTEXT_READ)`
instead of the org-level `INTEGRATION_READ` — closes a tenant-isolation gap
where a caller-supplied `organizationId` picked which tenant's Microsoft
credentials probed the project's contexts. `isMicrosoftAccessDeniedError` no
longer misclassifies an auth-shaped 403 (expired/invalid token, no refresh
available) as per-resource access-denied — those still need the reconnect
CTA, not "not readable by you". A transient probe failure (429/500/timeout)
is now warned and omitted from the response instead of being cached as a
false "Not readable by you" for 60s.

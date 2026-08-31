---
"fabric-app": patch
---

Protocol callers now resolve into an organization, and account settings are reachable from one

Six changes that together let a caller work without personal context, ahead of that context being removed.

A shared query answers "which organization is this user operating in" for callers that hold a user and no session tenant. One membership resolves to it; several resolve to the last active organization while the caller still belongs to it. Several with a stale or unset pointer resolve to nothing — deliberately. A tie-break would make the answer stable, and stability is not authorisation: dropping a credential into a tenant nobody named is the wrong failure mode. Both entry points therefore let a caller name one of their own organizations, membership-checked on the route that receives the request.

Both protocol servers consume that helper, and both stop reusing a cached session once it disagrees with the freshly resolved organization. Sessions live twenty-four hours, so without that the resolution change would have applied to new sessions only. The switching tool no longer accepts a null organization, its descriptions and refusals stop telling a model to ask for one — one of them was instructing a retry against a call that now always fails — and a successful switch persists last-active so the session and the resolver cannot disagree.

Account security and notification settings gain an organization-reachable home. Nothing moves: both are account-global, so this is a route and a link. It also closes a live gap where an organization member had no route to their own account settings from either the sidebar or the user menu. Automation templates, the task-planner agent and agent-register gain organization-rooted routes, with the six navigations inside them made context-aware so the pages do not walk the user back into the personal tree; a stale redirect stub is removed.

Fizzy #1875, FR3b/FR4/FR5.

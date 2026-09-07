---
"fabric-app": patch
---

Let editors choose a publishing topic's contributors, and feed that choice — not the AI-resolved list — to every content-generation prompt

Adds `contributorsOverridden Boolean` + `userContributorUserIds String[]` to `publishing_topic`, mirroring the existing post-type override pair. The boolean exists so an explicit empty override ("nobody") is distinguishable from no override at all (which falls back to the AI-resolved contributor list).

A single exported resolver, `effectiveContributorUserIds`, is now the one place that answers "who are this topic's contributors." Eight readers were routed through it: the topic list's wire mapping and handle hydration, the per-viewer author recommendation, the Inbox contribution ranking, five content-generation activities (blog post, short post, case study, stakeholder email, planning-analysis), and the contributor-notification reach.

A new oRPC procedure, `updateTopicContributors`, writes the override and rejects any id that is neither a current project member NOR already present in the topic's current effective contributor set — closing a gap where `resolveContributorNames`'s unscoped user lookup previously relied on ids being server-written to stay safe.

That second clause is a "grandfather" rule, added in a post-review fix wave: `resolveProjectContributorIds` deliberately resolves story/document/PR authors via any linked account, not just current project members, so a topic routinely names someone who has left the project or was never on it. Without the grandfather rule, an editor who opened the dialog only to add one person silently dropped every such contributor on Save, because the client intersected the checked set with the project's member list. The security property the membership check exists for is unchanged: an id can only pass because it was written by the server's own resolver or by an earlier call that already passed this exact check, so nothing new is ever disclosed through `resolveContributorNames`'s unscoped lookup.

The same fix wave closed two more issues in `ContributorsDialog`: the dialog re-seeded its checkbox selection on ANY parent re-render (not just a real data change), because `topic.userContributorUserIds ?? topic.contributors.map(...)` was recomputed inline in JSX and allocated a fresh array every render; both mounts now memoize it, mirroring how `PostTypesDialog`'s callers already do. And Save no longer treats a members query that is still loading or has failed as "no members" (`?? []`) — it now blocks Save and surfaces the failure, since an empty members list previously let a transient fetch failure clear a topic's contributors.

A `ContributorsDialog`, modeled on the existing post-type override dialog, lets an editor assign multiple contributors, remove themselves, and reset to the AI suggestion, from both the Inbox row and the topic page. Non-member contributors (grandfathered ids) get their own row, checked and removable, visibly marked as no longer a project member.

No `@repo/*` package bump — internal-only change, `fabric-app` patch covers the release.

---
"fabric-app": patch
---

Open one presence connection per project page instead of two, halving the join, heartbeat and SSE traffic a project detail page generates.

`useProjectPresence` was called twice in the same tree. `ProjectDetails` calls it for the refetch callbacks that react to document and context changes; `ProjectPresenceBar` — mounted through `ProjectHeader`, which only `ProjectDetails` renders — called it again for the avatar stack. Each call is a fully independent instance: its own `join` POST, its own two-minute heartbeat interval, and, through `useProjectRealtime`, its own `EventSource`. So every project detail page held two open SSE streams and posted every presence event twice, for one user viewing one project.

The hook already de-duplicates carefully — that work landed for an earlier burst of the same symptom — but it only ever sees its own instance, so it could not detect the second one. The fix is structural rather than another guard: presence is mounted once, at the top of `ProjectDetails` above the loading and not-found branches so join/leave do not churn as those flip, and shared through a new `ProjectPresenceProvider`. `ProjectPresenceBar` reads that context and throws if it is mounted without a provider, so a future consumer cannot silently reintroduce a second subscription.

`currentTab` existed only to feed the bar's own hook call and is gone from the `ProjectDetails` → `ProjectHeader` → `ProjectPresenceBar` chain; the surviving hook already tracks the active tab.

The document editor page keeps its own single call — it has one consumer and is not affected. The extra requests visible in dev there are React StrictMode's double-invocation, not this defect.

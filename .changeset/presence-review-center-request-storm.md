---
"fabric-app": patch
---

Stop the project page sending a leave/join/heartbeat burst on every tab change, and fetch the review-center badge count once per mount instead of once per observer.

Diagnosed from the Aspire browser-log resource: opening one project produced ~20 `POST /api/projects/{id}/presence` calls and two `reviewCenter.count` fetches. The presence hook listed `activeTab` / `editingDocId` in its join effect's dependencies, so each tab change (including the several intermediate values the active tab passes through on a cold load) ran the cleanup (`leave`) and the body (`join`) again, plus the separate update effect's `heartbeat`. The join, interval-heartbeat and visibility effects now read the current tab through refs and depend only on `projectId` / `enabled`; the update effect is debounced (300ms) so a burst sends one heartbeat with the final value. The review-center count hook drops `refetchOnMount: "always"` in favour of a 5s staleTime, so the panel mounting shortly after the badge reuses the badge's result while the 60s poll and focus refetch keep the badge current.

Tests: `useProjectPresence.test.tsx` (join once, no leave on tab change, single debounced heartbeat, leave on unmount) and `use-review-center-count.test.tsx` (second observer reuses the cache).

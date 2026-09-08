---
"fabric-app": patch
---

Roadmap filters now survive opening a feature and clicking "Back to roadmap"

The Roadmap tab keeps its filters (search text, kind, priority, stage, tags,
date ranges, quality flags, recency windows) as URL search params via nuqs.
Opening a feature navigates to the feature workspace route, which unmounts
the roadmap and drops that query string, and the workspace's "Back to
roadmap" control and "Roadmap" breadcrumb navigated to a hardcoded
`?tab=stories`, so every filter was reset on return.

The roadmap now remembers its serialized filter query per project in
sessionStorage (tab-scoped, mirroring the active-project-tab memory in
ProjectDetails), and the feature workspace builds its back URL and Roadmap
crumb from that memory: `?tab=stories` plus the remembered filters. The
breadcrumb href is read after mount to keep the server-rendered markup
hydration-safe; the back button reads storage at click time so an early
click is correct too. The project page's tab deep-link hook then consumes
`tab` and leaves the filter params in place for nuqs.

Files: lib/stories/roadmap-return.ts (new), hooks/useRoadmapFilters.ts,
components/stories/StoryWorkspacePage.tsx, StoriesRoadmap.tsx. Tests: 13 for
the helper, 2 for the serializer, 3 hook persistence tests with the nuqs
testing adapter, 3 added to the workspace header test.

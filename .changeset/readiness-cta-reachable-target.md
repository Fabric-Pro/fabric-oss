---
"fabric-app": patch
---

Readiness calls to action no longer lead nowhere when their destination tab is switched off.

"Explore Atlas" and "Scan codebase" registered a click and moved nothing on projects where those
tabs are not in the viewer's tab bar. The project tab bar is filtered per viewer — a feature flag,
admin tab configuration or a personal preference can remove a tab — and a `?tab=` naming a tab
outside that set falls back to Overview deliberately and silently, so the button looked broken with
no error and nothing on screen explaining it.

The panel now resolves each item's target against the tabs that viewer can actually reach, sharing
its cache with the tab bar's own hook so this costs no extra requests. An unreachable target
withdraws the button and says why, instead of pretending to work.

The existing guard could not catch this: it validates targets against the full static tab list,
flag-gated tabs included, so a dead button passed. It stays — it catches renames — and the
viewer-resolved path is now covered separately.

Severity rises with the project phase: Atlas and Security scan are not graded in Discovery, so this
was a dead button there, but both become Should items in Development / Execution, where a project
with the tab hidden would hold an item it could never complete.

The tab list moves into its own module so the panel can read it without importing the component
that renders the panel. Three tests parse that array by source and follow it; two of them also grep
the component for onboarding anchors, which stay where they are.

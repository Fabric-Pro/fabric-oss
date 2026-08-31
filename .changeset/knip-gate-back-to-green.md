---
"fabric-app": patch
---

Remove the dead settings forms and unused exports the personal-context removal left behind, restoring the knip gate

Nine components under the settings module were the personal-side forms of pages that no longer exist; each has an organization-side counterpart already in use, and nothing imported them. Two exports went with them: a naming helper only its own file calls, and a per-user `where` builder superseded when the drop job moved to set-based scoping.

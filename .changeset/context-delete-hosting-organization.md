---
"fabric-app": patch
---

Deleting an item from a project's Context tab now targets the search-index cleanup at the organization that hosts the project.

Fizzy #2638. The delete procedure took the tenant for the deletion workflow from the request body, and neither `requireProjectPermission` nor `hasProjectAccess` verifies that value against the project. A caller who reaches an organization-A project through the org-role fallback and also belongs to organization B could send B, or null, and the workflow deleted points from B's collection (or the personal arm) before deleting A's row, leaving A's points orphaned. The tenant now comes from the project row `getContextById` already loads, and a caller-supplied organization id that names another organization is refused with BAD_REQUEST. Pinned by delete-context.test.ts "the workflow runs under the project's hosting organization" (the null and foreign-id cases fail on the old code).

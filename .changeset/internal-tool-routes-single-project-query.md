---
"fabric-app": patch
---

Speed up AI agent tools by eliminating redundant project lookups.

`hasProjectAccess(projectId, userId)` already ran a `Project` fetch internally but discarded the `organizationId` it read, so every caller that also needed the tenant-XOR check re-fetched the same row a second time. Four internal routes that server-side agent tools call on every tool invocation — `project-context-search`, `code-search`, `teams-tools`, `slack-tools` — did exactly that: access check, then a duplicate `db.project.findUnique` just for `organizationId`. On an agent run that calls these routes up to ~20 times, each call paid for two sequential round trips to the same row.

Added `getProjectAccessContext(projectId, userId)` in `packages/database/prisma/queries/projects/projects.ts`, mirroring `hasProjectAccess`'s exact access-decision logic (personal-project owner/collaborator, org-member, and project-scoped-guest paths) but returning `{ organizationId } | null` instead of a boolean. `hasProjectAccess` is now a thin wrapper over it (`!== null`), so the two can't drift. Every branch returns the project's stored `organizationId` value as-is (never normalized) — the column is a nullable String with no non-empty constraint, so a row can hold `""` rather than `null`, and a tenant-XOR comparison needs the exact stored value to match what a second, independent fetch would have returned.

- `project-context-search` and `teams-tools`/`slack-tools` drop their second `db.project.findUnique` entirely — the organizationId now comes from the access-context result.
- `code-search` still needs a second fetch for repo fields (`repositoryUrl`/`repositoryOwner`/`repositoryName`/`defaultBranch`), but no longer re-selects `organizationId` there.
- `teams-tools`/`slack-tools`'s `isAuthorizedChat`/`isAuthorizedChannel` scope checks are untouched — still sequential, after access and the tenant-XOR check pass, exactly as before.

No change to the XOR filtering logic itself or to any 403/tenant-mismatch response body. `project-context-search`/`teams-tools`/`slack-tools` also drop a "Project not found" 404 branch that was reachable only when the project row disappeared between master's two sequential reads — a single read closes that window. Callers of these routes only special-case a 401; every other non-2xx status (404 included) already just surfaces the numeric status in generic error text, so nothing depended on that branch specifically.

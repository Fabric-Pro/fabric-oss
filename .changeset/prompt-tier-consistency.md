---
"fabric-app": patch
---

Make every prompt-default screen agree with the prompt the agent actually runs, and give the binding key real uniqueness

Fizzy #2068 follow-up. An independent review of the project-tier work found four
defects, all reproduced before fixing.

**The unique key enforced nothing.** Postgres treats NULL as distinct from NULL in a
plain unique index, and every binding shape carries at least one NULL in the composite
key — SYSTEM nulls userId/organizationId/projectId, org-wide ORG rows null
userId/projectId, PROJECT rows null userId, and every non-stage binding nulls storyKind.
Demonstrated on PostgreSQL 17.10 with the shipped index: two identical org-wide
defaults, both isDefault, pointing at different versions, both inserted. The index is
rebuilt with `NULLS NOT DISTINCT`, which is what the key always meant. Prisma cannot
express it (its docs state NULLs are treated as distinct and `@@unique` takes no nulls
argument), so the index is owned in the migration under the name the schema expects.
The migration dedupes first and runs as one blocking transaction, because a
CONCURRENTLY unique build that meets a duplicate leaves an INVALID index enforcing
nothing.

**Three readers disagreed with the resolver.** `listPromptCatalog`,
`listPromptsForStages` and `listAvailablePromptsForAgent` omitted the `projectId: null`
filter that `getBoundPromptVersion` and `getBindingStatusForPrompts` apply, so a
project-narrowed binding joined the org-wide ranking. The organization's Prompt Library
passes no project at all, so it could badge a prompt the agent would never resolve
there; the document-generation picker could surface another project's prompt entirely.
The condition now has one definition all five share.

**Binding was not atomic.** Standing the old default down and writing the new one ran as
separate statements on the bare client, so a failure between them left the action with
no default. It runs in a transaction now, and a concurrent bind adopts the winner's row
instead of failing the click.

**The panel changed something without saying so.** Setting a project default stands the
writer's own personal default for that action down, server-side; the toast now reports
it. The summary also called one tier "Fabric" where the badge beside it said "System",
and the project tier "This project" where the shared badge says "Project".

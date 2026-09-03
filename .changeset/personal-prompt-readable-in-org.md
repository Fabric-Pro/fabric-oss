---
"fabric-app": patch
---

Open a personal prompt from inside an organization instead of answering "Prompt not found"

`getPromptById` admitted `USER`-scope prompts only when no organization context was
present (`opts.userId && !opts.organizationId`). Since ADR-018 every account has an
organization, so that branch was always taken and a user's own personal prompt 404ed
on its detail page while the catalog happily listed it — the exact UI/runtime
contradiction CLAUDE.md warns about for the prompt queries.

This is the same Fizzy #2068 FR3/FR4 exception the binding resolvers already make:
`getBoundPromptVersion`, `getBindingStatusForPrompts`, `listPromptCatalog` and
`listPromptsForStages` all consult the caller's `USER` tier inside an organization.
`getPromptById` is a fifth reader that was missed. Isolation is unchanged — the
condition is filtered by `userId`, so nobody reaches a prompt that is not their own,
and the `ORG` condition still pins `organizationId`.

Reproduced on staging before the fix: `prompts/get/byId` returned `NOT_FOUND` under
session org context and `200` with the prompt when passed `organizationId: null`.
Pinned by four new cases in `personal-override-in-org-context.test.ts`; the two
behavioural ones fail against the unfixed query.

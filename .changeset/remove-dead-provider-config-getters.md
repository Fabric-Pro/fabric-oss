---
"fabric-app": patch
---

Remove two never-called AI provider config getters and the result interface only they used

Closes fabric-dev issue #54, the follow-up to #52. `getOrganizationDefaultProviderConfig` and `getUserDefaultProviderConfig` in `packages/database/prisma/queries/ai-gateway.ts` had no production callers — the only references outside their definitions were two keys in the `vi.mock("@repo/database")` factory of `configs.test.ts`, which the module under test never invoked. `ProviderConfigResult` existed solely as their return type, so it goes with them, and the stale mock keys are dropped.

knip does not catch this class of dead export because `@repo/database` re-exports through its entry barrel and `includeEntryExports` is off, so the removal was verified with `@repo/database` and `@repo/api` type-checks instead. No runtime behaviour changes; none of the removed symbols executed.

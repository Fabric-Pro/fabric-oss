---
"fabric-app": patch
---

Remove two unused AI provider "last used" timestamp helpers from the database query layer.

`updateOrganizationProviderLastUsed` and `updateUserProviderLastUsed` in
`packages/database/prisma/queries/ai-gateway.ts` had zero callers anywhere in the repo — a
grep across every tracked file type returned only their own definitions. They were superseded
by `updateProviderLastUsed({ configId, source })`, which takes the same two code paths behind
one `source` discriminator and is the only variant actually wired up (called from
`trackUsage()` in `packages/ai/lib/dynamic-model-selector.ts`).

Knip does not flag these: `@repo/database` re-exports them through its `index.ts` entry
barrel, and knip's `includeEntryExports` defaults to false, so exports surfaced from an entry
file are never reported as unused. The package is `private: true`, so there is no external
consumer either.

Found while investigating production DB load — the surviving `updateProviderLastUsed` fires on
every AI model resolution and is currently the largest single application query on
fabric-production by cumulative execution time. That contention issue is tracked separately;
this change only deletes the dead siblings and does not alter runtime behaviour.

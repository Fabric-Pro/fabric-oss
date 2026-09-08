---
"fabric-app": patch
---

Merge registered-agent metadata keys with one atomic jsonb UPDATE so concurrent card-cache, embedding and refresh writes no longer drop each other's keys.

Fizzy #2436. `updateAgentCardCache` and `updateAgentEmbedding` in
`packages/database/prisma/queries/registered-agents.ts` did findUnique →
spread → update with no lock, and `refreshDynamicAgent` spread a metadata
object read earlier in the handler. The card cache is rewritten on every
successful health probe and embeddings are persisted fire-and-forget from
agent search, so the read-then-write gap was open almost constantly and a
write landing inside it silently lost `agentCard` or `descriptionEmbedding`.

All three now go through `mergeRegisteredAgentMetadata`, a single
`UPDATE … SET metadata = COALESCE(metadata, '{}'::jsonb) || $patch::jsonb`
(the same shape as `incrementBackgroundJobCounts`). The merge stays shallow,
matching the spread it replaces. A zero-row update raises Prisma's own
`P2025` so the API audit middleware still classifies a vanished agent as
`error.not_found`, and `refreshDynamicAgent` runs the merge and its status
update in one transaction so `lastRefreshedAt` cannot advance on a failed
refresh. Pinned by
`prisma/queries/__tests__/registered-agents.metadata-merge.test.ts`.

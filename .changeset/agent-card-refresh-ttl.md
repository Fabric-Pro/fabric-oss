---
"fabric-app": patch
---

Agent health probes refresh the cached agent card at most every 30 minutes and regenerate its search embedding only when the text changes or daily.

The health probe (`checkAgentHealth`) ran on every probeable registered agent
roughly every 6 minutes (2-minute schedule, 5-minute staleness window) and, on
every healthy probe, unconditionally rewrote the `registered_agent.metadata`
JSONB column twice: once with a freshly fetched agent card (16 kB+) and once
with a freshly generated description embedding (~1536 floats), regardless of
whether either had actually changed. On staging that produced thousands of
blob rewrites per day across 17 rows with no users, plus an embedding API
call per agent per cycle.

Fixes, per Fizzy #2437:
- `CacheTTL.agentCard` (`packages/temporal/src/lib/redis-cache.ts`) is now the
  single source of truth for the agent-card TTL, raised from 5 to 30 minutes.
  `DB_CACHE_TTL_MS` in `agent-capabilities.ts` is now derived from it
  (`CacheTTL.agentCard * 1000`) instead of hardcoding its own 5-minute value.
- The health probe reads the stored `registered_agent` row once per healthy
  check. If the stored card is younger than the TTL it skips the fetch
  entirely. Otherwise it fetches and compares against the stored card via a
  small local `stableStringify` (sorts object keys, keeps array order): an
  identical card only advances the freshness timestamp
  (`touchAgentCardCache`, new additive query in
  `packages/database/prisma/queries/registered-agents.ts`); a changed card
  still does the full `updateAgentCardCache` write.
- `updateAgentEmbedding` gained an optional fifth `embeddingSourceHash`
  parameter (sha256 hex of the search text). The probe now skips
  regeneration when the stored hash matches the current search text's hash
  and the stored `embeddingGeneratedAt` is under a 24-hour bound (the hash is
  the real change guard; the 24h TTL only catches what the hash can't see,
  e.g. a manual metadata edit). `search-agents.ts`'s own embedding
  regeneration on a model mismatch is unaffected — it doesn't pass a hash.
- `agent-capabilities.ts`'s Redis (L1.5) cache read no longer extends the Redis
  TTL on a hit, so the shared TTL bounds how stale a card can be at every
  layer instead of letting a card read at least once per TTL live forever.

Files touched: `packages/temporal/src/lib/redis-cache.ts`,
`packages/temporal/src/activities/orchestrator/delegation/agent-capabilities.ts`,
`packages/database/prisma/queries/registered-agents.ts`,
`packages/temporal/src/activities/agent-health-monitor/health-probe.ts`, plus
their test suites.

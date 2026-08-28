---
"fabric-app": patch
---

Fabric MCP now exposes a feature's decision log and revision history, and reports whether the linked PM-tool card still reflects the spec.

`fabric_get_feature` returned what a spec says but nothing about where it came
from, so an agent (or a person) reading a feature through MCP could not tell a
requirement a product owner settled from one the AI proposed and nobody
challenged, could not see what the last maturation run rewrote, and had no way
to know the linked PM card had drifted from the spec.

Three additions, all read-only, all built on query helpers that already existed
(`listDecisionLogThreads`, `getFeatureVersions`, `getFeatureVersion`):

- `fabric_get_feature_decisions` — the threaded Decision Log, content passed
  through verbatim so callers can quote rather than paraphrase. Every entry
  carries `source` (`HUMAN` / `AI_CONFIRMED`) and every answer carries
  `answerSource` (`MANUAL` / `AI_EDITED` / `AI_SUGGESTED`), plus a
  `humanAuthoredThreads` count — an all-`AI_CONFIRMED` log reads as "decided"
  but is not. `openThreads` surfaces the unanswered questions that are the real
  scope risk. Optional `status` filter; counts always span the whole log.
- `fabric_get_feature_versions` — one entry per saved version with the enhance
  run's `changeSummary` bullets. Bodies are omitted from the list on purpose
  (a mature spec runs to tens of KB per version) and a single revision is opt-in
  via `version`, which also returns the summary-digest and working-notes
  snapshots as they stood then.
- `fabric_get_feature` — gains `maturationStatus` and a `pmSync` block
  (`autoSyncEnabled`, `lastSyncedStatusId`, `statusDrifted`). Auto-sync is off by
  default, so a PM card is a snapshot of the last manual push rather than a live
  mirror; `statusDrifted` compares the last pushed status against the current
  one.

Also tightens the file's `tenantFilter` helper to return the discriminated XOR
union instead of a widened `organizationId: string | null`, which is what the
decision-log query types its tenant argument as. Its one existing caller spreads
it into a Prisma `where`, where the narrower type is equally valid.

18 new tests in
`apps/web/modules/saas/mcp/lib/gateway/__tests__/feature-provenance-tools.test.ts`
pin the promises that make the output trustworthy: verbatim content, the
human-vs-AI distinction, counts that survive filtering, bodies absent from the
version list, page size clamped, and a personal-context session sending
`organizationId: null` rather than an org filter — asserted on the arguments the
query received, since a mocked query returns the right rows regardless of the
filter it was handed.

---
"fabric-app": patch
---

Add a date-aware meeting transcript lookup so the assistant stops reporting meetings that exist as missing

Fizzy #2473. Asked "do you see any meeting transcripts from September 10?", the project
assistant answered "no" and named the newest date it happened to retrieve as the most
recent on record. The transcript was present, Ready and Embedded the whole time.

Root cause is retrieval having no date dimension at any layer:

- `meetingDate` is a first-class indexed column on `ProjectMeetingTranscript`, but the RAG
  path never reads that table.
- `storeProjectContext` writes a fixed payload key set that drops `meetingDate`; the
  payload's own `createdAt` is the embedding timestamp and nothing reads it back.
- `searchSimilarProjectContexts` filters on project and tenant only — no date filter, no
  recency, no ordering.
- `ProjectContext.createdAt` is ingest time, not meeting time, and is useless as a proxy:
  a bulk backfill can stamp hundreds of meetings spanning months with one minute.
- No tool in the agent's surface could filter by date, so a date question had nowhere to
  go but semantic search over hundreds of near-identical standups.

Reproduced on production with a control that isolates it: the same `rag_query` tool, in
the same conversation two minutes apart, could not find the transcript by date but
returned it verbatim when asked by content — the model noticed the contradiction itself.
The "most recent on record" claim was also unstable across runs, naming dates months
apart, which is what a similarity artifact looks like and what a fact does not.

The fix is a lookup, not a better embedding:

- New `list_meeting_transcripts` tool backed by `listMeetingTranscriptsByDate`, ordered by
  the meeting's own `meetingDate` (already indexed, the same shape Meeting Digest queries).
  Registered on both agent seams — orchestrator handler and direct-chat built-in — through
  one shared module so the two cannot drift on what a date range matched.
- Shipped under the existing `project-context` capability, so every agent that can already
  search project context gets it with no migration or configuration change.
- RAG results now carry an explicit caveat that they are a similarity-ranked sample, not an
  inventory: absence from the set is not evidence a document is missing, and the newest
  item in it is not the most recent on record.
- The direct-chat formatter read `metadata.filename ?? metadata.type`, neither of which
  `RetrievedContext` populates, so nearly every source reached the model labelled
  "Context N" — stripping the one place a transcript's date appeared. It now reads the
  retrieval shape's own `filename` / `sourceTitle` / `sourceUrl`, matching the orchestrator
  seam's formatter.

Scope note: deliberately no participant filter and no MCP surface — meeting search over
MCP is tracked separately and owns the open questions about name matching.

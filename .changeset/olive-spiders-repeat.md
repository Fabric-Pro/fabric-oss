---
"fabric-app": patch
---

Meeting transcripts are now stored in full instead of being replaced by an AI summary once they pass a length threshold (Fizzy #2316)

A transcript longer than 50,000 characters had its body swapped for a ~3,000-word LLM summary at
ingest, and the original was never written anywhere — no second column, no file, no other store.
The Transcript tab rendered that summary under a label promising the real thing, and the
search/RAG embedding was generated from it too, so for those meetings the summary was not a
reading aid but the only record that existed. Roughly a quarter of stored transcripts were
affected, and it fell hardest on exactly the meetings where wording matters: long discovery and
kickoff calls. A sample of seven daily standups found three of them destroyed the same way, with
every survivor sitting within a few thousand characters of the limit — the threshold was a coin
flip on the most frequent meeting type, not a safeguard for unusual ones.

What changed:

- The transcript body is persisted whole, whatever its length. The summary is still generated for
  long meetings and still stored on the transcript row, where the Meeting Digest, the Daily Brief
  and the sync settings pane read it — it simply no longer overwrites the transcript. A failed
  summary now costs the digest a convenience rather than the record.
- `wasSummarized` changes meaning to "the verbatim original was destroyed". It is false for every
  row written from now on and stays true on the older rows whose originals are gone, which gives
  the Transcript tab an honest indicator without a migration.
- The backlog analyzer's cached-transcript path gained the size guard its two sibling producers
  already had. It previously relied on ingest having capped the stored body; without this, one
  long meeting would consume the analyzer's whole token budget and silently drop the project's
  Notion and RAG context, since meeting transcripts outrank both in the allocation order. AI
  Update's behaviour is deliberately unchanged by this release.
- The context-embedding workflow and activity now accept the body as optional and read it back by
  context id when it is omitted, so an unbounded transcript no longer travels inside a Temporal
  payload. Existing callers are untouched.
- The Transcript tab shows a short notice on meetings whose original was destroyed before this
  change, rather than presenting a summary as the transcript.

Requires a temporal worker deploy; a web-only deploy will not carry the ingestion change.

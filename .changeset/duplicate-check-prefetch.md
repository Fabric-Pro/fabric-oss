---
"fabric-app": patch
---

The duplicate check now starts while the user is still filling in the form, so creating a work item usually doesn't wait on it.

Fizzy #2180 latency follow-up. Staging measured the check itself at ~13s cold, 3-4s warm with no match, and up to 16s warm when the typed decision model has to weigh in — all of it in front of Create. `useDuplicateCheckPrefetch` (apps/web) now fires the same request on a ~1.5s typing pause or on blur, once the description clears ~20 characters, keyed by the exact trimmed text; a further edit aborts whatever was in flight for the old text. `handleSubmit` reuses a settled or in-flight prefetch for the current text through the same `checkBeforeCreate`, and falls back to a fresh call exactly as before when nothing usable is cached. Server-side, `check-duplicate.ts` now resolves the judge model concurrently with loading the routing corpus instead of one after the other, and its decision log carries a per-stage `ms` breakdown (embedding check, corpus, model resolution, judge, total) to make the next latency question answerable from the logs alone.

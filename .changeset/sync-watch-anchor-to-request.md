---
"fabric-app": patch
---

QA's "Sync now" now reliably shows the results it ingested — findings, case results, and section badges — without a page reload.

Fizzy #2722, #2723 (follow-ups to #2226). The prior fix judged a sync "finished" once every sync-state row's timestamp looked newer than the page's cached copy at click time, which is wrong whenever another writer (the 15-minute auto-sync, a teammate, another browser tab) rewrote those rows first: the first poll already looked complete, so polling stopped before this sync's own ingest landed. Two related gaps: a source row missing from that cached baseline (a first sync, a newly connected repository) counted as finished immediately, and a live source merely lagging another by more than ten minutes was wrongly treated as done.

Completion is now anchored to the exact Temporal workflow run the click started or joined (its run id), not to any row's timestamp — the same run the button starts is the one the fifteen-minute sweep would have started too, so a click during an in-flight sync joins it rather than racing it. The API gained a bounded describe-by-run-id procedure; the web watch polls it and re-reads every ingestion-derived query once that run closes.

Also fixed: the Testing tab's section badges and the QA traceability matrix's "last proved by" evidence were never wired into this refresh at all, and a test plan's creation or deletion never updated the section badge either.

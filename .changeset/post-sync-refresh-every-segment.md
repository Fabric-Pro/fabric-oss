---
"fabric-app": patch
---

After "Sync now", the Testing tab's case results, feature coverage and plan pass rates also update without a reload, even if you switch views mid-sync or the sync takes a while.

Fizzy #2226 follow-up, from the post-ship review of the first fix. That fix watched for the
ingest from inside the Runs panel, which (1) unmounted when the user switched to Cases, Features
or Plans, (2) stopped polling 30 s after the click whatever the sync was doing, (3) keyed on
lastFetchedAt, which a source that wrote results and then failed never advances, and (4) did
not refresh feature coverage, plans or an open case.

The watch now lives in a module-level store (use-pipeline-sync-watch.ts, the same pattern as
useStoryKindRegeneration) hosted by TestCasesList and the feature QA tab, above their sub-tabs.
It polls sync states until every source row present at the click has been rewritten
(advancePipelineSyncState and recordPipelineSyncFailure are the only writers; compared on the
server's updatedAt, never the browser clock), capped at the activity's own 10-minute bound, and
re-reads every ingestion product each time a row's updatedAt advances. listPipelineSyncStates
now selects updatedAt.

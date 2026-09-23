---
"fabric-app": patch
---

After "Sync now" finishes, the failure list and each test case's latest result update on their own instead of waiting for a page reload.

Fizzy #2226. The sync mutation only starts the pipeline-results workflow, so the findings and
test-case invalidation in its onSuccess re-read the pre-ingestion state and cached it. The panel
now watches the polled sync states and, when a source's lastFetchedAt advances (written after
that source's ingest has stored runs, results and findings), invalidates findings, unmatched
tests, the test-case list and result history.

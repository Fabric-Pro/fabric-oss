---
"fabric-app": patch
---

Security & Accessibility scans of large projects no longer fail every time: the scanned content now stays within Temporal's payload limits.

Fizzy #2502, root cause. The prod worker log for the failed scan shows `[TMPRL1103] Attempted to upload payloads with size that exceeded the error limit. size=2341768 limit=2097152` on each of the five gather retries: the gather activity returned 200 items of ~12 KB, and Temporal rejects any payload over 2 MB. The item ceilings allowed 200 × 16,000 chars (3.2 M), and the same items then go out again as the input of both AI scanner activities in one workflow task, where the 4 MB gRPC limit applies; on the local test server that second hop made the workflow task retry forever. `getProjectScanContent` now also applies a 1.2 MB serialized byte budget through a new `applyScanItemCeilings` helper, keeping the existing priority order (most recent activity first) and counting and logging every dropped item as before. A workflow test runs a prod-sized project's budgeted content through the real workflow on the Temporal test server.

---
"fabric-app": patch
---

A failed Security & Accessibility scan now says which step failed and why, instead of the generic "Activity task failed".

Fizzy #2502. When a scan step (starting the scan, gathering project content, saving results) exhausted its retries, the workflow recorded the Temporal ActivityFailure's own message — the wrapper text "Activity task failed" — as the scan error. The real cause sits in the error's `.cause` chain, so the banner, the notification and the `[SecurityScan] Scan failed` server log line all carried nothing to diagnose from. The workflow now unwraps the cause with the existing `unwrapPmSyncError` helper and prefixes the failed step. The transient-cause hint (rate limit / timeout / unavailable) still appends as before. Because the message now carries a raw cause that project members see, `failScanActivity` passes it through `redactSecrets` before logging, storing or notifying, the same scrub every stored finding field gets. Only the failure message changes, which is activity input and workflow result, so no patch marker is needed for replay. A workflow-level test runs the real workflow under the Temporal test environment and fails on the old code with exactly the prod banner text, "Activity task failed".

---
"fabric-app": patch
---

Re-indexing a repository no longer lets the replaced indexing run overwrite the new run's result: a late write from the superseded run can no longer mark a finished index as failed, reset it to indexing, or close the new run's Job Hub entry.

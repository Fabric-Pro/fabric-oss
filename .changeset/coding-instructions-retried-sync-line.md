---
"fabric-app": patch
---

Once a synced version's checks are retried and it publishes, the Coding instructions sync line reports the publication instead of a red failure.

Before, the last sync run still read "(Scheduled): failed" followed by a red "Checking version N stopped before it finished; its checks were retried and it is now published." — accurate but alarming for a resolved state. `settledByRetry` (instructions-repository-sync.ts) now recognises a CHILD_ABORTED run whose staged version is the published one, and RepositorySyncStatus renders it as the run's outcome ("published version N after its checks were retried") with no error line. History still lists the run as failed. The `errors.CHILD_ABORTED_RETRIED` key is replaced by `outcomes.retriedPublished`.

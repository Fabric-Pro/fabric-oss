---
"fabric-app": patch
---

The Testing tab stops checking for sync progress as soon as a sync finishes, even when a disconnected repository left an old sync record behind.

Fizzy #2226, found verifying the follow-up on staging: one of five sync-state rows had not been
written for ten hours (a source no sync touches any more), so the watch never counted the sync as
finished and polled every 10 s until its 10-minute cap. Rows one sync writes land within that
bound of each other, so a row older than it relative to the newest is no longer waited for.

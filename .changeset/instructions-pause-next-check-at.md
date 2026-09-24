---
"fabric-app": patch
---

A coding-instructions repository sync that pauses (missing branch or revoked delegate) no longer keeps a stale next-check time from the poll's expired lease; the schedule is cleared until the sync is configured again.

Fizzy #2703. The poll claim writes its two-minute lease into `nextCheckAt`, and a pause left that value behind, so a paused row read as an overdue check even though the poll never claims paused rows. The column is now nullable and the pause effect writes null; a re-configure still sets the row due immediately.

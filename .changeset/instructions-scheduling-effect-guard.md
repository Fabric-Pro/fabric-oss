---
"fabric-app": patch
---

A coding-instructions sync that finishes with a scheduling effect the server does not recognise now records an error and backs off the next check instead of silently skipping the schedule write.

Fizzy #2687. The scheduling switch had no default branch, so an unknown effect kind returned nothing, the caller skipped the write, and the row kept the poll's lease as its next check, surfacing only as a re-claim once the lease passed. The run receipt still completes; the scheduling helper itself now throws on an unknown kind so the mistake can never be a silent no-op elsewhere.

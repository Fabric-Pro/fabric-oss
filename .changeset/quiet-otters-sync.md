---
"fabric-app": patch
---

Reduce project-management sync database and capability-discovery round trips while preserving bounded cleanup behavior.

Fizzy #2433: reuse the workflow capability snapshot, avoid a duplicate wide story read during terminal reconciliation, and batch attachment lookup before bounded orphan deletion.

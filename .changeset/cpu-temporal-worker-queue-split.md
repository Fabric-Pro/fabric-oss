---
"fabric-app": patch
---

The Temporal worker can now be limited to a subset of its task queues, so CPU-heavy repository analysis and code indexing can run in a separate worker process and no longer stall every other background job while they work.

`WORKER_TASK_QUEUES` names the only queues a process polls and `WORKER_EXCLUDED_TASK_QUEUES` the queues it skips; with neither set the worker polls every queue as before. An unknown queue name, or both variables at once, stops the worker at boot.

---
"fabric-app": patch
---

The automatic coding-instructions poll now claims at most 400 syncs in one five-minute tick; a larger backlog is spread over the following ticks, which keeps each run's workflow history small and quick to replay.

Fizzy #2685. The four-minute budget bounded a tick's duration, not the number of checks it recorded, so a backlog of fast checks could record thousands of activity round trips in one history.

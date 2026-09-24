---
"fabric-app": patch
---

A push that arrives while a coding-instructions repository sync is already running is now re-checked at the next poll tick after that run finishes, instead of waiting for the 15-minute schedule.

Fizzy #2682. The push webhook, and a poll check, that find the project's sync run already open now leave a re-check request on the sync configuration, then settle it against that run's receipt under the configuration's row lock. When the receipt is still unfinished, the run's completion takes the same lock later, reads the request, schedules the next check for now rather than 15 minutes out, and clears it. When the receipt has already finished (the completion committed while the workflow was still closing), the settle applies the request itself. The request keeps the last observed head for diagnostics only, because webhook deliveries arrive in no guaranteed order and one slot cannot hold two observations. A paused sync keeps no next check, and a re-configure clears the request.

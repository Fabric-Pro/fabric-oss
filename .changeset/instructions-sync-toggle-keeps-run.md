---
"fabric-app": patch
---

Turning Coding Instructions' automatic repository sync on or off, or re-enabling it after a pause, no longer cancels a sync that is already running or makes suggestions in flight stale.

Configuring the repository sync now tells a change to what is synced (the repository, branch, folder or exclusions) apart from one that is not. Only the first bumps the configuration's generation, which fences an open run as `CONFIGURATION_CHANGED` and resets the automatic schedule. The "Automatic sync" toggle and "Re-enable" keep the generation and the schedule's cursors: they make the caller the member automatic runs act as, clear the pause and the failure count, and make the sync due now, dated on the database clock the configuration lock read, so any poll check's lease still ends. Because a re-enable no longer fences an open run, a run that later records a permission failure pauses automatic sync again only while the configuration's current member still lacks permission to add instructions. The audit row stays `project.instructions.repository_sync_configured`, now with `repositoryChanged` and `ignoreGlobsChanged` flags beside `refChanged` and `rootChanged`.

---
"fabric-app": patch
---

A project's Living Memory repository sync can now keep itself up to date: with "Keep in sync automatically" on, Fabric checks the branch every few minutes and also reacts to a GitHub push right away, running the same sync a manual Sync now performs and recording each run with what triggered it.

Automatic runs act as the member who configured the sync and re-check that member's permission each time; a branch that disappears or a permission that is revoked pauses the automatic checks with the reason shown in the Context tab, where a member can re-enable them. Manual Sync now keeps working whether or not automatic sync is on. A push that lands while a Living Memory sync run is already open is picked up by the next check after that run finishes, instead of waiting for the regular schedule. Living Memory's automatic checks lease on the database clock and date their next check from it, as the coding-instructions sync does, so a worker whose clock drifts no longer stalls or floods the schedule.

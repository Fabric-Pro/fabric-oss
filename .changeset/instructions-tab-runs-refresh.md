---
"fabric-app": patch
---

The coding-instructions History list of sync runs now refreshes as soon as the repository sync is reconfigured or switched to upload mode, so each run's "from an earlier configuration" marking is current when History is next opened rather than up to a minute stale.

Fizzy #2694. The settings change re-read the sync status and the file lists but left the run list to its cached copy.

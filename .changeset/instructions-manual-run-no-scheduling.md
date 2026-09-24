---
"fabric-app": patch
---

A manual "Sync now" of coding instructions that fails no longer pauses or delays the project's automatic repository sync; the failure stays on that run's own row and polling continues on its schedule.

Fizzy #2706. The outcome mapping applied the automatic-scheduling effect regardless of trigger, so a manual sync against a missing branch paused automatic sync with REF_MISSING and a transient manual failure bumped the failure count and backed off the next check. For a non-automatic trigger a would-be pause or backoff is now no effect; a successful head evaluation and a commit-keyed suppression still apply, so a manual success keeps moving the schedule and recording the cursor.

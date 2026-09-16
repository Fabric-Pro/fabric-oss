---
"fabric-app": patch
---

A Slack channel that can no longer be read — archived, or with the bot removed — now stops being scanned instead of failing on every interval forever.

These errors were already classified as permanent so the activity would not
retry them, but nothing stopped the polling, so the next interval reproduced
the same failure indefinitely. One archived channel had accumulated 53
identical failures.

Such a channel is now deactivated with its error recorded, which the existing
Resume control clears once the underlying problem is fixed. Errors that can
clear on their own, such as a missing OAuth scope, are recorded without
stopping the channel.

---
"fabric-app": patch
---

The status-sync line on a project's PM settings card no longer shows a healthy check when tickets could not be read: a run that read some tickets but not all is shown as a warning, and a run that read none is shown as a failure.

The hourly status check now reads only stories linked to the project's current PM tool. Stories still linked to a previously used tool are no longer requested from the new tool, where they failed every hour and kept the "Ticket statuses checked" time from moving, or, when the same number existed in the new tool, were read against an unrelated ticket.

When a GitLab connection's token has expired and cannot be refreshed, the hourly check now skips the project instead of recording every ticket as failed with no reason, and with status sync on the card says why, for example that GitLab rejected the token refresh. The reason is a fixed phrase with at most GitLab's short error code, never free-form text from GitLab.

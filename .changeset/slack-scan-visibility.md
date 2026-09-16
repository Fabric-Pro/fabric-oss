---
"fabric-app": patch
---

A finished Slack channel scan now reports what it found, so a scan with nothing to do is no longer indistinguishable from a broken one.

Running a manual scan on an up-to-date channel examines zero messages and
finishes in under a second, leaving the row unchanged; the only count on it
reports analyzed threads while reading "threads scanned", so it showed 0
whether the scan found nothing, correctly proposed nothing, or never ran.

A finished scan now says "no new messages" or names the messages and proposals
it produced, drawn from the Job Hub row the scan already writes. The counter
says "analyzed", which is what it counts. A channel the system stopped reads
"Stopped" rather than "Paused", since a user pause always records who did it.

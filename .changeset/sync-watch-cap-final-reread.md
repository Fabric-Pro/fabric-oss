---
"fabric-app": patch
---

QA's "Sync now" now catches up its results even when a sync runs long, instead of only when it closes cleanly.

Post-ship review of the run-anchored "Sync now" watch (Fizzy #2722) found two remaining gaps. First, the ten-minute give-up cap simply stopped polling without a final re-read, so a source write landing in the last poll gap — or a sync still running or unreadable at the cap — left findings, case results, and section badges stale until reload; the cap now runs the same final re-read the normal completion path does before it stops. Second, ending a watch was scoped only to the project, not to the specific run finishing: a stale completion handler for an old run could in principle clear a genuinely newer run's watch that a second "Sync now" click had already started; ending a watch is now scoped to the exact run it belongs to.

---
"fabric-app": patch
---

Publishing Suite: editors can assign people and scan for topics straight from the topic list, change a topic's status from its own page, and see each status change saved as soon as it is made.

On the Inbox list a status change now shows the new status at once, with Saving…, Saved or Not saved beside it, and the topic stays locked until the list has re-read it, then shows whatever the server holds; with the Inbox turned off, rows keep their previous behaviour. The topic page gains the same five-status control and dialogs, sharing one lock with Edit URL. An editor opens the assignee picker from a collapsed Inbox row's avatars, or from "Assign" when nobody is assigned. "Generate now" is now "Scan for topics" in Settings and operator copy, and is also on the list header; the list follows a run while it is live or a scan is unanswered and refreshes the topics when it sees the run finish. API identifiers (`generateNow`) are unchanged.

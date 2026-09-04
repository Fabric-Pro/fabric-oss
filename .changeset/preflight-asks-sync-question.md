---
"fabric-app": patch
---

Fix the reconnect preflight reporting every meeting as invisible, so repairing a healthy sync no longer offers "Reconnect 0 meetings".

The check resolved each linked meeting through `get_meeting_by_join_url`, which is `/me/onlineMeetings?$filter=JoinWebUrl eq ...`. Graph returns a row there only for the meeting's ORGANIZER, so every meeting somebody else ran came back empty and was reported as not visible. Two further faults stacked on top: the call passed `joinUrl` where that tool reads `joinWebUrl`, so it threw before it could even be wrong, and it read `.id` off a response shaped `{ meeting: { id } }`. The catch-all treated a throw as "unreachable", so the result was always total loss — the confirmation named every meeting as about to stop, and the commit path then refused the repair outright.

It now asks what the sync asks: one `list_calendar_meetings` read over the sync's own 30-day lookback, with linked join URLs matched case-insensitively, exactly as `listRecentMeetingInstancesForLinkedUrls` matches them. A calendar that cannot be read is reported as "could not check" rather than collapsed into "you can see nothing" — those are opposite recommendations.

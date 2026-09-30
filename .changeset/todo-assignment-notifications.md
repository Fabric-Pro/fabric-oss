---
"fabric-app": patch
---

You now get a notification when a to-do is assigned to you, whether a teammate picks you on the To Do page or a meeting's action items are matched to you.

Fizzy #2340. A teammate assigning you a to-do writes a `TODO_ASSIGNED` notification that names who assigned it and what the to-do says; it follows your email and webhook delivery settings like other assignments. When the meeting-digest owner matcher assigns one or more of a meeting's action items to you, you get one `TODO_MEETING_ITEMS_ASSIGNED` notification for that meeting, in the bell only. Meetings older than 30 days, re-runs of a meeting you were already told about, self-assignment, and assignments to non-member contacts notify nobody. Both kinds link to the To Do page, and the Assignments toggle in notification settings turns them off.

Email and webhook delivery now checks, at send time, that the recipient still belongs to the notification's organization, so a person removed from an organization no longer receives its notifications by email or webhook.

---
"fabric-app": patch
---

Publishing topics now open into a two-section Inbox with read/unread state and snooze, behind the default-off PUBLISHING_INBOX flag.

Fizzy #2265 (1D-2), the surface half of the Inbox. 1D-1 shipped the schema,
query layer and both procedures; this puts them on screen.

With PUBLISHING_INBOX on and no status chip selected, the topic list becomes
two sections — Recently Modified (IN_PROGRESS and SELECTED, newest first,
capped at three with an in-place "show all") and Suggested. Rows collapse to
title, angle and pitch, and expanding one is what marks it read; a manual
read/unread toggle sits beside the status control. Snooze leaves the status
dropdown and becomes its own action with three server-resolved durations, so
a snoozed topic keeps the status it had and returns to the right section on
its own. The decline rationale is finally rendered back to the reader — it has
been stored since the decline dialog shipped and never shown, while that
dialog told the user it was kept for context.

Off, the module renders exactly the list that shipped, which is why the 59
pre-existing component tests were left untouched and now serve as the rollback
regression guard. Read markers written while the flag was on are inert when it is off, and
intact when it is flipped back on. Snooze is not: the status filter chips
shipped in the previous slice already exclude snoozed topics independently of
this flag, so a topic snoozed while the Inbox was on stays hidden from the
status chips afterward — nothing becomes unreachable, it surfaces under the
Snoozed chip instead.

Not covered by the flag: the 1D-1 migration that moved previously deferred
topics to Suggestion. That already happened and does not reverse.

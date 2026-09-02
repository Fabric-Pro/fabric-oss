---
"fabric-app": patch
---

Pin that an owner-assignment notification reaches the owner's bell, not only the notifications table

The delivery suite proved a row was written. That is a weaker claim than the one
that matters: the bell matches `organizationId` exactly, hides incident types and
archived rows, and re-checks project access at read time, so a notification can
satisfy every assertion about its own columns and still reach nobody.

Adds three assertions through the bell's own read path — the row reaches the
owner's bell, it carries the `projectId` column the read-time access filter
depends on (`createNotification` maps `source.projectId` onto it, an indirection
nothing previously pinned), and it is correctly invisible from a different
organization's bell.

Demonstrated rather than assumed: writing the notification against the wrong
tenant leaves all four original row-existence tests green and turns both new bell
assertions red. The CI zero-skip guard moves from 4 to 7 so a dropped test is
caught too.

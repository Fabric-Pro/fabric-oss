---
"fabric-app": patch
---

Stop the Publishing Suite list reordering itself after an unrelated write, by breaking `createdAt` ties on a unique key

Found while validating 1D on staging (Fizzy #2265): snoozing a topic and
un-snoozing it left the list in a different order, and the new order survived
three clean reloads — so this was the server's answer, not a stale client cache.

The list was ordered by `createdAt desc` with no secondary key. That is not a
total order here: a generation cycle writes its topics in one batch, so every
topic from a cycle carries the same `createdAt` **to the millisecond**. On the
project used for the check, four topics formed two exactly-tied pairs. Postgres
may return tied rows in any order, and an `UPDATE` to one of them can move it,
so any write to a topic — a snooze, a status change — could silently reshuffle
the Inbox.

Ordering now breaks ties on `id`, the same key `listPublishingCycles` in the
same module already uses.

Why the existing tests were green: every order assertion in the real-Postgres
suite sleeps 5ms between inserts, with the comment "distinct createdAt
ordering". The fixtures deliberately avoid the tie, which is the one condition
that triggers the bug — so the suite could not have caught it, and none of
those six assertions change here. The new test asserts the query shape rather
than a returned array: performing the sort is Postgres' job, and the only thing
this layer owns is whether it *asks* for a total order.

Shipped alongside defaulting the Inbox on. That flip is what makes this worth
fixing now rather than later: it promotes a list that could reshuffle from
"whoever enabled the flag" to everyone's default view.

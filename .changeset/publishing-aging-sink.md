---
"fabric-app": patch
---

Sink quiet topics down the Inbox instead of only fading them where they stand

The card owner asked for topics untouched for ten days or more to start "lowering in the list"; what shipped faded them in place and moved nothing (Fizzy #1851). They now sink.

The Suggested section partitions into three groups rather than two. Everything under the aging threshold keeps its incoming order exactly — that order is 1B's per-viewer ranking, and it is untouched at the head of the section where personalization is the thing that matters. The aging band forms a tail below it, ordered by neglect ascending, so a topic quiet for ten days sits above one quiet for twenty-nine and the oldest is the last thing before the archive. Stale topics still leave the section entirely.

The earlier implementation argued that any third group is a sort by neglect, and that a sort must not touch the tier order. Half of that still holds and is why the split is shaped this way: nothing sorts the live topics. Ordering inside a group that is already sinking costs nothing tiering was protecting — a topic nobody has touched in three weeks is not being ranked for relevance any more, it is queued for archival.

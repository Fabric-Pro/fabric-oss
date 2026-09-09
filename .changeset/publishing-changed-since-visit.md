---
"fabric-app": patch
---

Tell a reader which generation tabs have changed since they were last there

Finding #46. The format tabs carried `GENERATED` and `NEEDS CONFIRMATION` — facts about the draft. What was missing is a fact about *your* last visit, so the new badge sits beside them rather than replacing one: both can be true of the same tab.

The marker is its own table rather than a column on the existing topic read marker. That row means "this topic has been opened" and unreading *deletes* it, so adding a post type would change what its absence means and break the one-row-per-reader shape the Inbox's unread dot depends on. The constraint that shaped both: neither may touch `PublishingTopic`. Reading must not bump a topic's `updatedAt`, or opening one would reorder "Recently Modified" underneath the person reading it.

"Changed" is measured against the **draft's** own timestamps, never the topic's — a topic changes for many reasons, a status flip, an assignee, an answered question, and none of them is a reason to say a blog post has changed. A tab nobody has ever opened says nothing: absent means "not changed", not "changed", and `RECOMMENDED` already marks a tab worth a first look. A failed drafts read claims nothing either, since a badge derived from data that did not arrive is worse than silence.

Opening a format tab is what clears it — the strongest form of looking there is. The write is fire-and-forget: a failed marker costs a stale badge, which is not worth a toast interrupting what the reader just asked for.

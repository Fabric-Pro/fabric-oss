---
"fabric-app": patch
---

An amended publishing answer keeps its text when the server refuses the write, and the topic masthead stops colliding with its label

Two fixes found while checking the review findings rather than while building them.

The amendment editor closed on submit rather than on success, so a `stale` refusal (someone amended first) or an outright failure discarded the only copy of what the person had typed while the toast said nothing was saved. It now closes only when the write landed, leaving the draft beside the refreshed answer.

The masthead's `BackLink` and `.editorial-label` are both `inline-flex`, so they shared a line and touched — and the container's `space-y-3` could not separate them, because `margin-top` cannot break a line. The link is block-level now. jsdom has no layout, so no test can pin this.

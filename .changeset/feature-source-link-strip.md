---
"fabric-app": patch
---

Features created from a Teams or Slack proposal now show a "Proposed via" strip with a link to the source conversation, like bugs already do.

Fizzy #2503 follow-up. The F-171 reporter strip on the work item page was
BUG-only, so a feature's source link lived only inside the Details popover.
The strip is extracted to `StorySourceStrip`: bugs keep their existing
visibility rule, and any other kind shows the strip once it has a
`reporterSourceUrl`. The link text is now "View source conversation →" for
both, matching the Details popover.

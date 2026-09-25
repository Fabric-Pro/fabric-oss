---
"fabric-app": patch
---

The work item source strip keeps its "View source conversation" link readable when the story column is narrow.

Fizzy #2503, found by the post-#624 responsive sweep: at 768px with the AI
assistant panel open, the one-line strip truncated the link to "View …" because
the chip could not shrink. The link now keeps its width (`shrink-0`) and the
"Proposed/Reported via" chip and reporter name truncate first.

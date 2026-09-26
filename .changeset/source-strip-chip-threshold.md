---
"fabric-app": patch
---

Phones show the "Reported via" and "Proposed via" label on the work item source strip again.

Fizzy #2503, found by the post-#631 sweep: the `@xs` (320px) threshold hid the
chip on a 375px phone, where the strip has 312px of content, removing the bug
strip's existing "Reported via TEAMS" label on mobile. Measured on staging:
chip 127px + gap + link 163px is about 302px; strip content is 312px at 375,
351px at 414, 185px beside the AI panel at 768. The threshold is now `@2xs`
(288px), so the chip hides only in the squeezed tablet column.

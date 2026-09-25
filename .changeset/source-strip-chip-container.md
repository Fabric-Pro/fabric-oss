---
"fabric-app": patch
---

The work item source strip hides its "Proposed via" label in a narrow story column instead of showing an empty badge.

Fizzy #2503, found by the post-#630 responsive sweep: at 768px with the AI
assistant panel open, the link kept its width but the chip shrank to an empty
rounded pill. The strip is now a `@container` and the chip shows only from the
`@xs` container width (320px), which the strip has on a 375px phone and
wider layouts but not in the squeezed tablet column.

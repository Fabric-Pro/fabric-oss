---
"fabric-app": patch
---

The source strip on work items stays on one line, so opening the AI assistant no longer shifts the page, and source links are easier to tap.

Fizzy #2503, found by the responsive sweep of #616 on staging. At 768px the AI
assistant panel narrows the story column, the new feature strip wrapped to a
second line, and the editor below moved down 15px: a 0.324 layout shift on
every load (feature page CLS 0.288 before #616, about 0.5-0.6 after). The strip
now uses `whitespace-nowrap` with its parts truncating, so its height cannot
change with width. The strip link, the inbox "see original" link and the
"See original conversation" expander get a 24px minimum hit area (WCAG 2.2 AA
target size); they measured 16px tall.

---
"fabric-app": patch
---

The Planning & Analysis editor keeps a stable height, gains a table of contents, and puts version provenance next to the button that changes it

Fizzy #1851. Three problems with one cause. The rich editor had no height constraint and grew with its content, while the raw textarea had a 300px floor that does not auto-grow — so toggling between them made a short analysis jump taller and a long one collapse into an internal scroller. The toolbar unmounting in raw mode moved the box a third time.

The region now owns its height and everything nests inside it, so losing the toolbar only changes how a fixed height is divided. That same height is what the shared `DocumentTocRail` docks against — the component already served the document editor and Feature Maturation, and needed something definite to stick to.

Version provenance and the History trigger move up beside Generate, from below the editor and below the structured sections, where they sat far past the fold while the action that changes them was pinned at the top.

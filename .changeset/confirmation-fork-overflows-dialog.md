---
"fabric-app": patch
---

The confirmation dialog's third button no longer hangs outside the dialog, and its stacked mobile layout no longer runs the buttons together.

A confirmation that offers a safe alternative renders three buttons — cancel, the destructive action, and the alternative. Their labels sum past the dialog's default width, and the footer is a grid item, so its minimum width is its own content: the row cannot shrink to fit and the last button renders past the card's right border. Seen on staging on "Unlink and delete context / Pause scanning, keep context".

Two changes. The footer wraps rather than overflowing, so no label length can push a control outside the card again, and it separates its buttons with a gap rather than a horizontal margin — the margin utility was scoped to the row layout and did nothing at all to the stacked one, leaving the mobile buttons touching. The dialog also widens when a secondary action is present, which keeps the intended reading order on one line — cancel, then destructive, then the safe alternative — instead of orphaning the alternative onto a second row.

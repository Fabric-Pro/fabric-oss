---
"fabric-app": patch
---

Each project tab can now show its icon, its title, both, or neither, chosen per tab by each member.

Fizzy #1837. The tab bar shows every tab's icon and title again, reversing the icon-only default
of the previous round. Icon-only became a per-tab choice instead: each row in the Customize tabs
dialog carries two toggles, Icon and Title. Both on is the default and stores nothing, one off
narrows what that tab paints, and both off is how a member hides a tab.

The separate hide control is gone, because "both off" already says it. The row keeps its place
in the list so turning either toggle back on restores its position, and focus stays on the
toggle that moved it. Overview and Settings cannot be hidden, so their last remaining toggle
locks and says why.

`hidden` stays the one list every other surface reads, so deep links, Get Started filtering and
tab resolution keep a single source of truth. The new `display` map only records how a surviving
tab paints, and its absence means both halves, so preferences saved before this release keep
resolving without migration.

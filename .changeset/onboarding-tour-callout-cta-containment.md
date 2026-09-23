---
"fabric-app": patch
---

The "Show me around" button in the onboarding tour invitation now sits inside the callout instead of hanging over its right edge, with even spacing from the card's borders and its usual alignment against "Don't show again".

The callout was 288px wide with 16px of padding, leaving 256px for its two actions, which together need 284px. Neither could give the space back: the shared button base sets both `whitespace-nowrap` and `shrink-0`, so the labels cannot wrap and the buttons cannot compress, and the action row had no `flex-wrap` to fall back on. The row therefore overflowed its own box, and `justify-between` pinned the primary action to the end of that overflowing row — roughly twelve pixels past the card border.

The callout is now 352px, sized from the measured row rather than the nearest step up, which leaves about 36px of slack so one extra word of copy or the button's own loading spinner cannot quietly push the actions onto two lines. The action row also gains `flex-wrap`, matching the tour spotlight's action row, so that if the pair ever does outgrow the callout again it reflows onto a second line instead of escaping the card. Plain `justify-between` is kept deliberately: pairing `justify-end` with an auto margin looks equivalent while the row fits on one line, but resolves per line once it wraps and would strand the two actions in opposite corners.

A regression test pins both halves of the repair, the callout's width and the row's wrap tolerance, because a component test runs without a layout engine and cannot assert the overflow itself. It guards against either being changed unnoticed rather than verifying the fit directly, so a single label wider than the content box would still overflow — the shared button keeps its no-wrap and no-shrink behavior by design.

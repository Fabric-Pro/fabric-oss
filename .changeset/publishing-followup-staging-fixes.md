---
"fabric-app": patch
---

Stop printing the Planning & Analysis heading twice, and put the analysis document back beside its contents rail

Two defects found in the 9 September staging review of the #1851 rework (Fizzy #1851).

**The heading was printed twice.** The Planning & Analysis panel rendered an `editorial-label`
reading "PLANNING & ANALYSIS" directly beneath the tab that already said it. This was reported in
the first review and recorded as fixed — wrongly: the commit credited with removing it only moved
the paragraph into a new wrapper alongside the relocated History button, so it appears as both a
removal and an addition in one hunk and was never actually deleted. The row keeps its controls on
the right by switching from `justify-between`, which with the label gone would have pushed them
under the tab strip.

**The document sat in the wrong place.** `PROSE_MEASURE_CLASS` carried an `mx-auto` that the
pattern it cites — the topic page's own pitch paragraph — does not have. The contents rail is
`shrink-0`, so the auto margins split only what the rail left over and centred the 768px reading
column inside the remainder, opening a wide blank gutter between the rail and the text it belongs
beside. The two other consumers of `DocumentTocRail` cap nothing at all, so a capped column had
never been exercised against that asymmetric layout. Left-aligning restores the reading measure
without the gutter.

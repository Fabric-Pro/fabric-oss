---
"fabric-app": patch
---

Give the PriorityRankedList large no-filter re-prioritize test its own 30 s ceiling so it stops timing out under the CI fan-out

The case "confirms a large no-filter list before running, then sends the whole set (no ceiling caution below 500)" renders 101 full story rows in jsdom, drives the confirmation dialog with userEvent, and then waits for the mocked reprioritize call. `PriorityRow` is memoised, so the clicks do not re-render the whole list; the initial render is the expensive part. On a quiet machine the case takes about 1 s; under the unit-tests job, where four packages' vitest workers share the runner's eight cores, it has run past vitest's 10 s default. fabric-oss run 33724214428 clocked it at 12 s, and fabric-dev runs 33711689286, 33714245799 and 33711699779 failed the same way on 2026-09-03 on branches that touched no web code. Every other web test passed in each run, and a rerun got past it.

101 is the smallest list that crosses `REPRIORITIZE_ASK_THRESHOLD` (100), so the row count cannot come down without losing the behaviour under test. The >500 sibling case avoids the cost by driving the large set through the entire-roadmap scope, which is counted but not rendered; that trick does not apply to the no-filter path, where the list on screen is the list being confirmed. Mocking the row component would be file-wide and would weaken the 26 other cases that click into real rows. So the fix is the per-test timeout the card proposed, set on this one `it` rather than on the file or the config, so that a genuine hang elsewhere in the suite still surfaces at 10 s.

The earlier commit 7c593822 widened the Re-prioritize button wait inside this describe block from Testing Library's 1 s to 5 s after a different failure signature (fabric-oss run 33738973241, "Unable to find role" at 3.3 s). That lookup timeout is unchanged here; it now runs inside this test's 30 s budget.

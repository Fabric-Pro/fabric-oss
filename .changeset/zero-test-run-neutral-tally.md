---
"fabric-app": patch
---

A CI run with no test results yet now shows a muted "No test results" badge instead of "0/0 passed", in the run list and in the run detail.

Fizzy #2224. A verified webhook delivery publishes a run's metadata straight away, and the
per-test breakdown only arrives with the next sweep, so for up to a sweep interval every count
is zero. The run row tried to handle that state (#2291) with the `secondary` badge, which was
the emerald accent at the time and is why QA measured a green "0/0 passed". The badge only
turned grey later, as a side effect of the design-system change. The run detail sheet never
had a guard and still rendered 0/0 as `success` green, so a failing suite could read as a pass
there until the sweep ran. In both places the label also said "passed" when no test had run.

Both surfaces now render the tally through one `RunTallyBadge` component. A run with
`totalCount === 0` gets the muted `info` badge with the text "No test results". Passing runs
still render as success and failing runs as error. The row test used to rule out only
`text-success`, which let the emerald `secondary` badge through. It now checks for the muted
class directly, and a new detail-sheet test covers all three tallies.

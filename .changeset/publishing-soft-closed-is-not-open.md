---
"fabric-app": patch
---

A publishing question the analysis stopped raising no longer counts as one you still have to answer.

Fizzy #1851 follow-up, and the counterpart to the re-asking fix: with the
analysis no longer re-raising settled decisions, what was left behind became
visible. A topic whose every live decision was answered still badged `7` on
Summary & Questions and read `21 of 28 decisions answered` — all seven being
`POSSIBLY_RESOLVED` roots stranded by the subject-drift bug that fix removed.

Nothing could ever clear them. A soft-closed root is not in the questions
panel's open list — it sits collapsed under "Possibly resolved" — and it returns
to `OPEN` only if a later analysis raises the same question again. Now that the
analysis correctly stops re-raising, that never happens, so the badge could not
reach zero and the topic could not reach 100%.

Feature Maturation, which this feature mirrors on the same `DecisionStatus`
enum, has always counted it the other way: `evaluate-ai-readiness.ts` puts
`POSSIBLY_RESOLVED` in `resolvedQuestions`, and the enum's own comment calls it
"dropped from the active open list". Publishing had diverged.

Two counting surfaces now follow FMv2:

- the Summary & Questions tab badge counts `OPEN` questions only;
- topic readiness counts a soft-closed question as settled, so it stops sitting
  in the denominator as permanently unanswerable.

The DRAFTING side is deliberately unchanged. `isUnresolvedDecisionStatus` still
admits `POSSIBLY_RESOLVED`, so the generation-tab caution and the prompt
restrictions stay conservative: an unapproved customer name is unapproved
whether or not the newest analysis still asks about it. A test pins that pair —
badge gone, drafting caution still there — so the two halves cannot be flipped
together by accident.

Two existing tests asserted the old rule and are reversed here deliberately,
not adjusted to fit: "does not count a soft-closed question as answered" and
"counts every unresolved question, a soft-closed one included".

---
"fabric-app": patch
---

The publishing Planning & Analysis asks for each decision once — not again after it is answered, and not twice in one run.

Fizzy #1851 follow-up. A topic regenerated four times asked whether it could name
a customer in eight separate decision rows, under three different kinds, and the
owner answered it every time.

Four causes, found by reading the topic's own decision rows:

1. The prompt carried no memory of what had been settled. The analysis is
   re-derived from scratch on every regeneration, so the model re-reached the
   same decisions in fresh wording, and `deriveQuestionId` — which hashes
   `(decisionKind, subject)` precisely so it does NOT collapse two genuinely
   different subjects — saw a new identity each time and minted a new root
   beside the answered one. This is the fix: `generatePlanningAnalysisActivity`
   now reads the topic's decision thread and the locked clauses carry every
   settled decision with the member's own answer, as a rule the analysis may
   not reopen. Locked rather than templated, because a bound prompt that
   predates the block would render nothing for a new variable — and that is
   exactly the prompt that has been regenerating longest.
2. Both producers, one list. `reconcileTopicQuestions` runs twice per completed
   analysis, once over questions and once over blockers, so one decision returns
   as a question ("may we use the name?") and as an errand ("get sign-off for
   the name"). `settledBlocker` is a sibling of `settledDecision` sharing its
   body, so the planning prompt suppresses both; the seven drafting activities
   keep seeing questions only.
3. Subject drift across a slash. `a / b` and `a/b` hashed differently, because
   collapsing whitespace runs never touches a single space beside punctuation —
   two space characters were enough to re-ask a settled decision. This changes
   existing identities: a live root whose subject carries a spaced slash
   re-derives to a new id and is soft-closed beside a new one, costing one
   duplicate once on that topic's next regeneration. Bounded — six such roots
   exist, one of them OPEN — and it cannot fail a write: the partial unique
   index on `(topicId, questionId)` carries the same predicate the reconciler
   reads with.

4. Duplicates WITHIN one run. A question and a blocker about one subject are
   one decision in two costumes, and the identity key cannot see it: the two
   producers word the same subject differently on purpose, and one run raised
   naming a customer three times over (an `ASSET_APPROVAL` question, a
   `CUSTOMER_NAME` question and a `MISSING_APPROVAL` blocker). The overlap was
   recorded in code as deliberate — "one is a decision, the other is an errand" —
   and is now overruled: the distinction survives in the wording, not in the
   item count. `foldDuplicateDecisions` collapses them onto the earliest,
   strongest item (the bucket-derived question, which carries clickable answer
   options) and carries the folded sentence onto its `whyItMatters`, so one
   answer settles both and both framings stay visible. It FOLDS rather than
   drops, because `blockers` never reaches the stored analysis document and a
   discarded one would leave no trace. Matching is subject-level containment at
   0.6; kind-level coverage was rejected because a MISSING artifact is absent
   from `requiresApproval` by definition, so it would have dropped two real,
   non-duplicate blockers. Validated against every multi-item run on record: 4
   duplicates folded, 0 false merges. One real duplicate is missed at 0.5, and
   that score is shared with a pair that must not merge (two different people's
   quotes), so the miss is pinned in a test rather than tuned away.

Kind drift (the same decision classified `CODEBASE_DETAIL`, then `MISSING_DATA`,
then `MISSING_APPROVAL` across three versions) is not separately fixable through
the identity key, and is addressed by (1).

Tests: 28 added across the prompt builder, the activity and the shared settle
helper; full publishing suites green in `@repo/temporal` (1212), `@repo/utils`
(1389) and `@repo/database` (431).

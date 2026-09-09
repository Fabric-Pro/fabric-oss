---
"fabric-app": patch
---

Measure the Publishing Suite: record every human verdict on a generated draft, analysis revision and topic outcome

The Suite shipped with one signal — `answerSource` on a decision entry — which
measures whether a recommended answer was taken and says nothing about whether
the feature works. Nothing counted posts generated, revisions made, or people
publishing.

This slice maps those moments onto `AiOutcomeEvent`, the AI-adoption table built
for Fizzy #2230, rather than building a parallel one. `publishing-suite` joins
`AI_FEATURE_KEYS`; the per-content-type split lives on `subjectType`
(`publishing-short-post` / `-blog-post` / `-case-study` /
`-stakeholder-email` / `-analysis` / `-topic`), so `GROUP BY featureKey` still
answers "is the Suite working" while `GROUP BY featureKey, subjectType` answers
"which content types are".

Emissions, all after the mutation they describe has committed:

- adopt a candidate (all four content types) → `ACCEPTED_AS_IS` on the draft
- save an edited body over an adopted candidate → `ACCEPTED_WITH_EDITS` on that
  same draft
- regenerate or refine past an existing candidate → `REJECTED` on the superseded
  draft
- save a revision of the AI planning analysis → `ACCEPTED_WITH_EDITS` on the
  revision
- decline a topic → `REJECTED`; publish a topic → `ACCEPTED_AS_IS`

Which makes the asked-for numbers derivable without a bespoke table:
regenerations-per-adopted-draft is the `REJECTED` run before an `ACCEPTED` for
one topic, "how much revision" is `ACCEPTED_WITH_EDITS` against
`ACCEPTED_AS_IS`, and distinct publishers is `COUNT(DISTINCT userId)` over the
published rows.

Two deliberate deviations, both documented at the code:

- The superseded-draft rejection refuses to overwrite a verdict this user
  already accepted. `AiOutcomeEvent` holds one row per (feature, subject, user),
  so a blind `REJECTED` would erase the `ACCEPTED_WITH_EDITS` written when the
  same person edited the body they adopted — destroying the revision count in
  exactly the adopt → edit → refine flow. The guard reads the recorded verdict
  rather than inferring adoption from `workingDraft.sourceDraftId`, which is not
  evidence: the first generation seeds a working draft pointing at its own
  candidate, so inferring from it would drop the rejection on every first
  regeneration.
- Topic verdicts are recorded for manual-origin topics too. The distinct
  publisher count needs them and is not recoverable if they are dropped, whereas
  origin is: `subjectId` is the topic id. An acceptance rate over
  `publishing-topic` that does not exclude `origin = MANUAL` is inflated.

Every emission goes through `lib/publishing-outcome.ts`, which swallows and logs
its own failures, so a measurement write can never fail the adopt, save or
decline it describes. `recordSupersededDraft` uses a narrow
`getLatestReadyDraft` rather than `listTopicDrafts` on purpose: the four
generate procedures are asserted never to reach for the latter outside
`readRefinementSource`, because a generation that reads the working draft could
leak saved work into a prompt.

The short post has no body-edit mutation (there is no `saveShortPostBody`), so
its `ACCEPTED_WITH_EDITS` moment has nothing to hang off and is not emitted.

Not instrumented, and worth a follow-up: the publishing Temporal activities do
not tag their model calls with a `featureKey`, so outcome rows will not join to
`AiUsageLog` by feature. Model correlation still works — `modelCanonicalName` is
carried on the outcome row itself.

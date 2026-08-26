# Feature QA tab

The per-feature QA surface: AI QA analysis, the acceptance-criteria traceability matrix, linked cases and CI runs.

- **Audience**: engineers working on the feature workspace QA panel
- **Owner**: Fabric platform team

Rendered by `QaPanel` in the feature workspace, beside Summary & Questions,
Decision Log and Full Specification. Shown only for features (not bugs), under
the maturation editor, and gated on `NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES`.

---

## QA analysis

`Generate QA analysis` grades the feature's **clean spec** — description plus
acceptance criteria — and stores the result. Regenerating is explicit; the panel
shows when the stored analysis was produced and flags it stale when the spec has
since changed.

Depth comes from `Project.qaStrategyLevel` (`LIGHT` / `STANDARD` / `STRICT`,
Settings ▸ AI Assistant). `LIGHT` produces warnings only, and the panel says so
rather than rendering an apparently empty analysis.

The acceptance-criteria blob is **bounded at the first sibling section** before
being sent, so operational tail content ("## A case can be linked and still unplaceable

The matrix has two buckets below the criterion rows, and they mean different
things:

- **Not mapped** — the case carries no criterion reference at all.
- **Linked to a criterion that could not be found** — the case names one, and
  Fabric cannot place it. Either the reference is free text, or it is a number
  past the end of the criteria because the specification shrank after the case
  was written.

They were one bucket. Telling somebody a case is unmapped when they explicitly
mapped it sends them round the same loop: they map it again, and the second
attempt fails identically. The fix for the second bucket is almost always the
criterion text, not the case.

The compliance export prints the unresolved reference verbatim, under its own
heading, for the same reason — an auditor reading "not mapped" would conclude
nobody tried.

## Release Planning") cannot be read as
criteria or skew the "AC N" numbering. The staleness hash deliberately stays on
the raw columns, so any spec edit — including that tail — still marks the analysis
stale.

The prompt is a **seeded, editable prompt binding**. Several clauses are composed
in code rather than in the template — the sibling-features block, the
locked-attachment rules, the project's function-tag role clause and the TDD block
below — so they survive an organisation-level prompt override.

### On a test-driven project, the analysis reads the cases too

When `Project.applyTddApproach` is on, the feature's already-drafted cases are
listed in the prompt and the model is asked to review the spec **against them**:
which criterion the cases contradict, which case tests behaviour the spec never
promises, which criterion no case covers.

This is gated on TDD for a reason. Without it, cases are drafted *after* this
review, so reviewing against them would be grading the model's own later output.
The clause is what finally makes the "Apply TDD approach" switch change an
outcome rather than a sentence of copy. The listing is bounded at 60 cases — a
mature feature can carry dozens, and this rides inside an already-large prompt.

**Ruling, 2026-07-26: under TDD, this analysis IS the feature review.** The TDD
flow asks for a "Feature Review based on Requirements AND Test Cases", and this
is it — it reads both and reports against both. There is deliberately **no**
second, separate review stage: it would be a second model call over substantially
the same inputs, producing a rival verdict on the same screen, and leaving
everyone to work out which one to believe. Recorded here rather than left to
inference, because "is that step done?" is otherwise answerable only by reading
the prompt-composition code.

What it does **not** do is write anything back. The analysis *reports* on the
spec; it never edits requirement text. Updating cases to match what was actually
implemented is a separate path — see *Revising a case* below.

## Revising a case

A case can be out of date in two different ways, and they have different answers.

**Against the specification.** The case was drafted from the feature's text, and
that text has since been rewritten. This is what the *Out of date* section lists:
cases whose recorded spec fingerprint no longer matches the feature's current
one. **From spec** proposes steps that verify the acceptance criteria as they
stand now. Accepting one stamps the case with the current fingerprint, so it
stops being listed.

**Against the implementation.** The spec may be untouched and the case may still
be wrong, because what shipped is not quite what was written down — a control
renamed during review, a step folded into another. **From implementation** reads
the diff of the pull request that implemented the feature and proposes steps that
match the code.

Where that pull request comes from matters: `CodingRun.storyId →
pullRequestNumber`. That is the only record linking a feature to the change that
implemented it. A repository's pull-request list carries no feature id, and the
code index describes the whole repository rather than one story's change. **When
no coding run recorded a pull request, the button refuses and says so.** There is
deliberately no paste-a-PR-number fallback: a control that claims to check the
implementation and quietly re-reads the spec instead is worse than one that does
not work.

The trigger is a button, never automatic. A coding run reaching `PR_OPENED` means
the agent finished — not that its pull request survived review. Revising a suite
against a diff that is about to change is work thrown away twice.

**Accepting a From-implementation proposal does not clear the spec-drift flag.**
That revision read code and never looked at the specification, so marking the
case as matching one would state something nobody checked. A case can honestly be
both revised-from-implementation and still spec-drifted; it stays listed until
someone reconciles it with the spec. The rule is enforced by a `proposedFrom`
value stored on the case when the proposal is written, not by a flag the caller
passes — so the path that must not stamp cannot be made to by a caller that
forgets.

The prompt names the diff as the ground truth and is given the case's current
steps but **not** the acceptance criteria. Handed both a diff and a spec, a model
averages them into something that offends neither, and an averaged test case
verifies nothing.

Both paths write to the same place and wait for the same Accept/Reject: an AI may
propose a change to the suite, never make one. Diffs are read up to 200 KB and a
truncated read says so on the proposal, because a revision that saw half a change
must not read as one that saw all of it.

**Where each control lives.** *From spec* appears on the **Needs a look** section,
and only for a case that actually drifted — a case whose fingerprint still
matches has nothing for it to correct. The same revise-from-implementation
action appears there too, and on every row of the feature's own case list,
because it can be asked of any case including a hand-authored one.

It carries a **shorter label in the case list** — *Revise* rather than *From
implementation* — because that row is 363px wide and the full label made the
button 53% of it, truncating the case title. The accessible name and the tooltip
are identical in both places, so the two are one control, not two.

That is also why **Needs a look** lists more than drifted cases. A proposal is
only reachable from that section, so a case that can hold one but never appears
there is a case whose Accept and Reject do not exist — the proposal would be
written, billed, and then stranded. The section therefore lists cases that are
spec-drifted **or** carrying an outstanding proposal, and its summary line says
which is which. A case with neither is still left out: it was never derived from
the feature text, and telling somebody their own hand-written case is out of date
is the false alarm this signal exists to avoid.

Output sections, each rendered only when the stored analysis carries it:

- **Under-specified criteria** — per-criterion warnings that the criterion is too
  ambiguous to test reliably, plus general warnings.
- **Integration implications** and **E2E scenarios** — markdown.

## Traceability matrix

Each acceptance criterion with the cases covering it.

Acceptance criteria live as **one markdown blob** on the feature — there is no
addressable AC entity. `parseAcceptanceCriteria` splits that blob into ordered
criteria and joins real `TestCase` rows to them by the drafter's free-text ref
("AC 3"). Two consequences worth knowing:

- The parser must reproduce the drafter's counting exactly, or the matrix and the
  drafter disagree about which criterion is "AC 2". A second implementation,
  `countAcceptanceCriteria` in `packages/ai`, sizes the drafter's per-criterion
  cap and follows the same rules.
- A case whose ref resolves to no parsed criterion lands in an explicit
  **unmapped** bucket. Nothing is silently dropped.

Parsing rules: top-level list items are criteria; **nested sub-bullets fold into
the criterion they qualify** rather than becoming criteria of their own; thematic
breaks (`---`, `* * *`) are skipped; H3+ headings are sub-group separators; a
leading H1/H2 heads the criteria while a later one bounds them; with no list at
all, non-heading paragraphs become criteria.

**Export** produces a markdown file for audit. It refuses to flatter the data:
uncovered criteria are printed with an explicit gap marker rather than omitted,
and when only part of the case list was loaded the document opens with a bold
partial-export banner naming the counts. It exports AC↔case coverage and each
case's current result — not pipeline runs.

## Other sections

- **Flow notice** — states whether the project drafts cases after review
  (standard) or before (TDD), from `Project.applyTddApproach`.
- **Pipeline results** — the same `PipelineRunsPanel` the QA tab renders,
  but scoped: it lists only the CI runs that actually tested **this** feature,
  and only the failures whose matched case belongs to it. A feature nothing has
  tested shows an empty state saying exactly that, rather than the project's
  runs. The untracked-tests triage list is omitted here — a test with no Fabric
  case has no feature to belong to — and lives on the QA tab instead.
  Each failure can be sent for an **AI cause analysis**, which writes a labelled,
  model-attributed hypothesis onto the finding and files nothing.
  See [pipeline results](./pipeline-results.md).
- **Linked cases** — the feature's cases with identifier, title, AC ref, state and
  result, each linking into the QA tab.
- **History** — two timelines: drafting runs (status, cases created, who, when,
  error) and QA analyses (depth, who, when). A failed fetch shows a per-list error
  rather than an empty state.

## Actions

- **Generate/Refresh QA analysis** — disabled without acceptance criteria.
- **Draft cases** — disabled without criteria, while a drafting run is active, or
  when the project's `generateManualTestCases` switch is off (with a tooltip
  explaining which).

The drafting-run watcher is mounted here too, so a run started from this tab
survives navigation.

## The coverage line outside the tab

The story workspace also carries a read-only **"tested by N cases"** rollup with a
popover listing them, deep-linking into the QA tab.

Where it sits is deliberate: it renders in the **always-present action bar**, not
inside the AI-gated editor, so coverage is visible on a project with no AI
provider configured. It is gated on the Test Cases flag — both the line and its
query to a gated procedure disappear when the feature is off.

## Source locations

| Area | Path |
|---|---|
| Panel | `apps/web/modules/saas/projects/components/stories/maturation/QaPanel.tsx` |
| Matrix helpers | `apps/web/modules/saas/projects/lib/stories/qa-traceability.ts` |
| Coverage line | `apps/web/modules/saas/projects/components/test-cases/StoryTestCoverageLine.tsx` |
| Analysis generation | `packages/api/modules/projects/lib/generate-qa-analysis.ts` |
| Procedure | `packages/api/modules/projects/procedures/stories/maturation/generate-qa-analysis.ts` |

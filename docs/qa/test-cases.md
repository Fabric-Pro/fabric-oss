# Test cases

Authoring, planning, AI drafting, PM sync and result recording for Fabric test cases.

- **Audience**: engineers working on the QA tab and its API
- **Owner**: Fabric platform team

Test cases are first-class entities, not documents: they have identifiers, steps,
state, results, history, plan membership and links to the features they cover.

---

## The model

`TestCase` carries an identifier (`TC-001`, minted zero-padded to three digits),
a title, a description used as **preconditions**, an ordered list of
`TestCaseStep` (`action` / `expected`), an owner, tags, and:

| Field | Meaning |
|---|---|
| `state` | `PROPOSED` / `DRAFT` / `READY` / `CLOSED`. `PROPOSED` is what a sceptic role authors — it awaits a human's Accept or Reject and **does not count as coverage** until accepted. AI drafting never produces it; drafting outputs `DRAFT`. |
| `currentResult` | `NOT_RUN` / `PASSED` / `FAILED` / `BLOCKED` |
| `automationStatus` | `NOT_AUTOMATED` / `PLANNED` / `AUTOMATED` |
| `automationRef`, `automationFilePath`, `automationExternalUrl` | how an automated test is recognised as covering this case — see [linkage](./pipeline-results.md#linking-a-result-to-a-case) |
| `lastRunAt`, `lastRunSource`, `lastRunByLabel` | denormalised provenance of the latest result |

Related: `TestPlan` and its ordered membership, `TestCaseWorkItemLink` (to a
feature or bug, optionally carrying `acceptanceCriterionRef`), `TestResultEvent`
(append-only result history) and `TestCaseDraftJob` (an AI drafting run).

## The QA tab

Five segments: **cases**, **plans**, **features**, **runs**, **questions**.

### Cases

Server-side filtering throughout — search, state, priority, automation, result,
PM-link, feature, plan and tag are all query parameters, so they narrow the whole
result set rather than the loaded page. Sorting is likewise a query parameter.

The **stat strip** reads a server-computed summary: total, state mix, automation
coverage, CI coverage and pass rate. Two things worth knowing:

- The summary is deliberately **state-independent**, so the All/Draft/Ready/Closed
  segment counts do not collapse onto the state you are filtered to. Because of
  that, the Total card reads "Total (all states)" while a state filter is active.
- **Automation %** counts only cases that are `AUTOMATED` *and* carry a ref, so
  intent recorded without a link cannot inflate it. **CI coverage** counts cases
  whose latest result came from a pipeline. **Pass rate** is over *executed* cases
  only.
- When the project's QA policy has index coverage enabled, both rings show the
  configured **coverage target** and render below-target in the highlight tone.

**Bulk actions** apply either to a list of ids or, once escalated, to the filter
predicate itself — so "select all N matching" reaches rows the browser never
loaded. Available: set state, mark result, add to plan, sync, delete, and a
project-wide result reset. Ticking or unticking a row always describes a concrete
set of rows and therefore drops the escalation.

## Manual order

The list can be sorted by **Manual order**, and rows can be dragged to set it —
but only in the one view where a drag means what it looks like. `TestCase.order`
is a **single global column per project**, while this list is offset-paginated and
filterable on nine dimensions, so all four must hold:

| Gate | Why |
|---|---|
| Sorted by Manual order | Dragging under any other sort either snaps back on the next fetch or rewrites `order` while the reader watches a list ordered by something else. |
| Ascending | The payload numbers rows 0..n-1 top-to-bottom; under `desc` the dragged row lands at the opposite end from where it was dropped. |
| No filters | The visible rows are a subset. Renumbering them 0..n-1 assigns values that collide with the hidden rows, so the unfiltered list returns interleaved. |
| Everything loaded | The same collision one page down — renumbering the loaded prefix overwrites order values the unloaded tail still holds. |

When a reader has chosen Manual order and any other gate is closed, the list says
**which one**, because a drag that silently does nothing reads as a broken feature.
One reason is shown, not all of them. Permission is never given as a reason: a
viewer sees no handles at all, so telling them their sort is wrong would send them
to change a setting that was never the problem.

A drop renumbers the **whole** visible list from 0 rather than nudging one value.
Nothing had ever written this column, so ties exist; moving a single value would
leave the tie unresolved and the list would settle differently on the next read.

The grip is a real `<button>` — dnd-kit's keyboard sensor drives reordering
through the focused activator, so a non-focusable handle would make reordering
mouse-only.

### Plans

A plan is a named, ordered grouping of cases with a pass-rate rollup.
`TestPlanRunner` walks the plan case by case for a manual run: mark
passed/failed/blocked (with `p`/`f`/`b` shortcuts), skip, step back, finish. Each
mark writes a real result through `recordResult`; progress is per-sitting and not
persisted as a run object.

### Features (coverage)

Per feature or bug: case count, distinct acceptance-criteria refs, pass rate, and
a binary **Covered / Uncovered** chip. The chip is binary by design — a partial
percentage over free-text criteria would be a guess wearing the costume of a
metric — and `distinctAcRefs` is reported as a tally, not a ratio.

### Runs

CI results. See [pipeline results](./pipeline-results.md).

### Questions

The QA open-questions log: what is unclear about testing something, recorded
against the project or against a specific feature.

A question carries `OPEN` / `ANSWERED` / `DEFERRED` status, filterable from the
segment header. `DEFERRED` records that the team decided not to settle it, which
is a different statement from leaving it open.

`answeredAt` and `answeredById` are stamped when a question moves to `ANSWERED`
and **cleared on any other status**, so a question reopened after being answered
does not keep a stale answer timestamp claiming it was settled.

Two details worth knowing:

- `userStoryId` is **nullable**. Project-wide questions ("is `flow:critical` the
  final label convention?") are exactly the kind that otherwise go unrecorded, so
  a question does not have to belong to a feature.
- The asker is stored as `askedByLabel`, a display string, with `askedById` set
  only when a human raised it. The asker is often not a `User` row — an AI
  persona such as "AI · Security Reviewer" attributes the same way — and the
  label survives account deletion.

## AI drafting

`Generate with AI` drafts cases from a feature's **acceptance criteria**; a
feature with none is skipped rather than billed, because the model would have
nothing falsifiable to test against.

- Runs as a background `TestCaseDraftJob` (Temporal), watched by a component that
  outlives the dialog and survives reload, so a run started before a refresh is
  picked back up. Cancellation is supported mid-run.
- Output is **always `DRAFT` / `NOT_AUTOMATED`** — AI never finalises a case.
- Up to 5 features per run; the per-run case cap is raised to the criteria count
  when a feature has more criteria than the default cap, so "at least one case per
  criterion" stays satisfiable.
- Each case names the criterion it validates (`acceptanceCriterionRef`, e.g.
  `"AC 3"`).
- The structured-output schema is deliberately **lenient** (plain strings, no
  enums) because the AI gateway rejects stricter schemas; priority is normalised
  in code.
- The prompt is a **seeded, user-editable prompt binding** (`test_case_drafter`),
  resolved at runtime — not inline text. Changing the template in
  `seed-prompts-only.ts` alone reaches fresh installs only; a deployed
  environment needs a migration that UPDATEs the bound version.

The project's **QA policy** (Settings ▸ Testing) is rendered into the prompt: the
rigor, the evidence expectation and the enabled sceptic lenses are turned into
instructions a model can act on. See [QA settings](./qa-settings.md).

There is **no dedupe against existing cases** — drafting appends. Running it twice
over the same feature produces near-duplicate cases.

**Reviewing what a run produced.** Drafting is non-blocking, so by the time a run
finishes its dialog is long gone. The batch is therefore addressed **by the run**,
not by a filter: the results sheet lists every case that run created with its
title, state, priority, step count and the criterion it covers, reviewable without
opening each one. That is also why the completion notification deep-links with a
job id rather than a set of filters — a filter would drift as cases change.

## Gating on project policy

`Project.generateManualTestCases` (default **on**) gates AI drafting. When off,
the server rejects a draft request *before* claiming a job or starting a workflow,
so nothing is billed, and both the QA tab and the feature QA tab disable
the control with an explanatory tooltip.

Manual creation, cloning and PM import are **not** gated by it.

## Results and history

`TestResultEvent` is append-only. Each event records the result, its source
(`MANUAL`, `PM_SYNC`, `PIPELINE`), when it occurred, who or what produced it, an
optional plan, an optional external run reference and URL, and a note.

The case's `currentResult` is a denormalisation of that history under
worst-wins-within-a-run and latest-wins-across-runs rules — see
[pipeline results](./pipeline-results.md#what-ingestion-writes).

The editor's **Runs** section shows the newest events with their source badge and
provenance; the row's result control shows "last run by …" and offers
Passed / Failed / Blocked / Not run.

## PM tool sync

Cases sync bi-directionally with PM tools that hold **native** test cases (Azure
DevOps, Xray, Zephyr, GitLab). The sync controls are gated on that capability:
a tool exposing only generic work items cannot receive test cases, and the control
says so rather than failing on use.

Per case: an auto-sync switch, a status chip (`PENDING` / `SUCCESS` / `CONFLICT` /
`FAILED`), and retry/dismiss on failure. `Import from PM` browses the connected
tool's tickets and imports them as cases; already-imported tickets are marked.

## Key source locations

| Area | Path |
|---|---|
| UI | `apps/web/modules/saas/projects/components/test-cases/` |
| Feature QA tab | `.../components/stories/maturation/QaPanel.tsx` |
| Procedures | `packages/api/modules/projects/procedures/test-cases/` |
| Queries | `packages/database/prisma/queries/projects/test-cases*.ts` |
| Drafting prompt | `packages/ai/lib/prompts/test-case-drafting.ts` |
| Drafting activity | `packages/temporal/src/activities/test-cases/` |

## When drafting starts on its own

Both project switches describe an *order*, and each names the moment drafting
happens. `packages/api/modules/projects/lib/auto-draft-test-cases.ts` owns both
moments so the two flows cannot drift apart:

| "Apply TDD approach" | The moment | Predicate |
|---|---|---|
| **On** | the feature reaches **Ready for Dev** | `shouldDraftOnReadyForDev` |
| **Off** (default) | the **feature review** completes | `shouldDraftAfterFeatureReview` |

Exactly one of the two can fire for a given project, because they disagree on
`applyTddApproach`. "Generate manual test cases" is the master switch above both:
off means no automatic run in either flow.

Both triggers share one eligibility rule (`isAutoDraftEligible`) — QA feature on
for the deployment, item is a FEATURE rather than a bug, generation switched on,
and **no cases yet**. That last condition is why reaching either moment twice
does not re-bill: a feature can move back to Draft and forward again, or be
reviewed a second time, while the requirements settle. The drafter's own dedupe
runs *after* the model call and would not have prevented the spend.

Both runs are fire-and-forget. Nobody pressed a drafting button, so a failure has
no surface to appear on, and failing the stage transition or the review because a
drafting run could not start would be worse than not drafting.

### Test-first: at Ready for Dev

"Apply TDD approach" promised that cases are drafted straight after the
requirements and before implementation. Until 2026-07-31 it did not do that: the
switch changed review ordering and prompt content, and drafting stayed a button
in both flows.

**Ready for Dev is `FeatureDraftingStage.PUBLISHED`.** Finding the right signal
mattered — `MaturationStatus` (TO_DO / DISCOVERY / DONE) looks like the lifecycle
and is decorative by its own schema comment, and Kanban statuses are per-project
user-defined columns no code can safely match on by name. `PUBLISHED` means "the
requirements are done" for every project whatever they have named their columns.

On top of the shared eligibility rule, `shouldDraftOnReadyForDev` adds:

- the stage actually changed (re-saving Ready for Dev bills nothing)
- **"Apply TDD approach" is on** — the opt-in, off by default

Both procedures that write `draftingStage` carry the trigger:
`stories.updateDraftingStage` (roadmap drag, stage menus) and
`stories.updateStageWithVersion` (the transition dialog inside the feature
editor). Only the first had it until 2026-08-12, so a user who moved a feature
to Ready for Dev from the editor got no draft even with test-first on — a
guarantee only one of the two paths honoured is not a guarantee.

### Standard ordering: after the feature review

With test-first **off** — the default — the settings page and the feature's
Testing tab both say *"cases are drafted after the feature is reviewed"*. Until
2026-08-12 nothing observed that review, so on the default settings no feature
was ever drafted automatically at all: the roadmap could be walked end to end and
`draftJobs/list` stayed empty. The promise lived entirely in copy.

The review is `maturation.generateQaAnalysis`, and its completion is the moment.
There is no earlier one and no stage means "reviewed" —
`UserStory.draftingStage` tracks requirements maturity, not review. The trigger
sits after the persist **and** after the idempotent-replay return, so a
double-click that serves the stored analysis does not claim a second run.

This is also why the review loads existing cases into its prompt only under
test-first: with the standard ordering those cases are drafted *from* this
review, and feeding them back would grade the model's own later output.

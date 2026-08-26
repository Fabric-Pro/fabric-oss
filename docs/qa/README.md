# QA

How Fabric authors test cases, tracks their coverage, runs them, and ingests automated test results from CI.

- **Audience**: engineers working on the QA surface; support engineers diagnosing a project whose QA tab looks wrong
- **Owner**: Fabric platform team

This is the entry point for QA documentation. Detail lives in the child pages
below; this page covers the shape of the system and the vocabulary the rest
assumes.

| Page | Covers |
|---|---|
| [Test cases](./test-cases.md) | Authoring, plans, AI drafting, PM sync, results, open questions |
| [Pipeline results](./pipeline-results.md) | Pulling CI results, linkage, RCA bugs |
| [CI provider setup](./ci-providers/README.md) | Per-provider credentials, scopes and traps — one page each, add a page to add a provider |
| [Pull-request review](./pr-review.md) | Reading a PR, the QA and architecture lenses, grounding, and what was built for them that no ticket asked for |
| [Fabric-driven runs](./agentic-runs.md) | Running a case by driving a browser: dispatch, statuses, the cost cap, evidence |
| [Verification](./verification.md) | Proving the pipeline works against a real provider — the checks unit tests cannot make |
| [QA settings](./qa-settings.md) | Settings ▸ Testing and Settings ▸ Environments |
| [Feature QA tab](./feature-qa-tab.md) | Per-feature QA analysis and traceability |
| [QA documents](./qa-documents.md) | Test plan / report / traceability document types |
| [Workflow Editor coverage](./workflow-editor.md) | End-to-end scenario catalogue for the Workflow Editor, what covers each, and the known gaps |

---

## What the system does

Fabric holds a feature's specification, drafts test cases from its acceptance
criteria, and then reads back what a customer's CI actually ran — linking each
automated test result to the case it proves and, optionally, opening a bug when
one fails.

```
Feature spec ──► AI drafts test cases ──► cases synced to PM tool (optional)
                                              │
Fabric starts a run ──► customer CI runs ──► Fabric pulls results ──┴──► matched to
      (optional)                                    │                   cases ──► case result,
                                                    │                   history, coverage
                                                    └──► optional bug on failure

Fabric drives the case itself ──► per-step observations, evidence ──► case result,
      (a browser, an environment)                                     finding on failure
```

Results reach a case from two directions. Fabric **reads** what the customer's CI
publishes, and can **start** a run in that existing pipeline — see
[starting a run](./pipeline-results.md#starting-a-run). Fabric can also **run a
case itself**, driving a browser through its steps against one of the project's
environments — see [Fabric-driven runs](./agentic-runs.md).

What Fabric never does is write CI configuration, create repositories, or push to
a customer's repository. The CI snippet generator hands over text for a person to
commit, and says so on screen.

## Vocabulary

- **Test case** — a `TestCase` row: an identifier (`TC-001`), a title,
  preconditions, ordered `action`/`expected` steps, a state and a current result.
  Cases are first-class entities, not documents.
- **Test plan** — a named, ordered grouping of cases (`TestPlan`), used for manual
  run-throughs.
- **Work-item link** — the join between a case and a feature or bug
  (`TestCaseWorkItemLink`), optionally carrying the acceptance criterion the case
  covers (`acceptanceCriterionRef`, e.g. `"AC 3"`).
- **Automation ref** — how an automated test is recognised as belonging to a case
  (`automationRef`, `automationFilePath`). See
  [linkage](./pipeline-results.md#linking-a-result-to-a-case).
- **Pipeline run** — one ingested CI run (`TestPipelineRun`) plus its per-test
  breakdown.
- **Result source** — where a result came from: `MANUAL`, `PM_SYNC`, or
  `PIPELINE`.

## Where it appears in the product

- **Project ▸ QA tab** — five segments: `cases`, `plans`, `features`
  (coverage), `runs` (CI results), `questions` (the open-questions log). Source:
  `apps/web/modules/saas/projects/components/test-cases/`.
- **Feature workspace ▸ QA tab** — per-feature analysis, traceability matrix and
  linked cases. Source: `.../components/stories/maturation/QaPanel.tsx`.
- **Project Settings ▸ Testing** and **▸ Environments** — the QA policy and its
  deployment targets.
- **Project ▸ Documents** — the QA document types (QA strategy, test plan, test
  report, traceability matrix). See [QA documents](./qa-documents.md).

The `runs` segment and the feature QA tab render the **same** `PipelineRunsPanel`
component, deliberately, so the two surfaces cannot drift apart.

## Feature flag

The entire QA surface is gated on `FABRIC_FEATURE_TEST_CASES` (server) and
`NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES` (client). **Both default to off** — the
server gate fails closed, and the client gate hides the tab and guards the
content branch, because the active tab is persisted in `sessionStorage` and a
stale value must not render.

There is no longer a separate pipeline-results flag:
`assertPipelineResultsEnabled()` delegates to `assertTestCasesFeatureEnabled()`,
so CI results ride the same gate as the rest of the QA surface.

Settings ▸ Testing and Settings ▸ Environments ride the same client gate:
`ProjectSettings.tsx` reads the flag once at module scope as
`QA_SETTINGS_ENABLED` and passes it to both the tab list and the renderer
(`showQa`). Both pages configure the QA tab and nothing else — `ProjectEnvironment`
has no non-QA consumer — so hiding the tab while leaving its settings reachable
would strand a reader on a page that configures something invisible.

> **If Settings ▸ Testing is missing, the flag is off.** That is the first thing
> to check when a project appears to have lost its QA configuration.

## Tenancy

`TestCase`, `TestPlan`, `TestCaseDraftJob`, `TestPipelineRun`,
`TestPipelineSyncState`, `ProjectQaSettings`, `ProjectEnvironment` and
`QaOpenQuestion` are top-level tenant tables carrying the XOR `organizationId` /
`userId` columns copied from the parent project, and are registered for row-level
security.

Two guards enforce this and should not be weakened:

- `packages/database/__tests__/rls-coverage.test.ts` fails when an
  organization-scoped table has no RLS policy, **and** when a table registered
  `user_owned` for RLS is missing from `tenant-db.ts`. The second direction
  matters because `getTenantFilter` returns `null` for an unregistered model and
  the query then runs **unfiltered** — it fails open, not closed.
- QA procedures take `projectId` and derive tenancy from the project;
  `requireProjectPermission` is the boundary. No caller-supplied organization is
  trusted.

## How the shipped system relates to its cards

The QA surface was specified across six cards. What shipped follows them closely
in most places, diverges deliberately in two, and goes beyond them in several.
This section is the map, so nobody has to reconstruct it from commit history.

### Where the cards came from

The cards trace back to an SDET-lead assessment (*Fabric QA — Three Operating
Models*, June 2026), which proposed three **phased** models for Fabric's own
engineering QA discipline, to be adopted in the order 3 → 2 → 1:

| Model | Phase | What it means |
|---|---|---|
| **3 · QA Onboard / Self-Verifying AI** | 1 — foundation | An implementing agent is not done until it has documented the cases, automated them across the pyramid, and re-verified its own work against the acceptance criteria |
| **2 · AI Review Gates** | 2 — trust layer | A dedicated `qa-reviewer` independently grades finished work against a versioned rubric (block / flag / pass), because in Model 3 the author still grades its own homework |
| **1 · In-House QA** | 3 — destination | A standing QA function with a per-project `qa-config` (`qa_level: light \| standard \| strict`), four QA agent personas, and dedicated performance / security / AI-eval pillars |

**Read that distinction carefully before using it.** Those models describe how the
Fabric *team* tests Fabric — an internal engineering process. The cards turned
parts of them into **product** features for customers. The two are related but
not the same thing, and conflating them leads to false expectations:

- The depth tiers (Light / Standard / Enterprise) echo Model 1's internal
  `qa_level: light | standard | strict`. The stored enum is `EASY | AVERAGE |
  HARD`; only the words on screen differ.
- The pull-request review lens **is** Model 2. See the note below — the
  assessment reached the same conclusion this codebase does.

### Built as specified

| Card | Subject | Notes |
|---|---|---|
| 1878 | Test-case generation toggles | `generateManualTestCases` (on) and `applyTddApproach` (off) live on `Project` and are genuinely read — generation is guarded in `ai-draft-test-cases.ts`, the TDD branch in `generate-qa-analysis.ts`. |
| 1688 | Test repository access & CI/CD | Connect a repository, generate a CI snippet, ingest results, propose a cause on failure. |
| 1689 | Test run management | Select a scope, start a run, follow it to completion, read the outcome. |

### Built differently

| Card | What the card said | What shipped, and why |
|---|---|---|
| 1834 | Results are pulled from **PM tools** (ADO confirmed, Jira/GitLab TBC) | Results come from the **code repository** only. The PM connection cannot return test runs, and Jira needs a third-party app nobody confirmed. FR1/AC1 are rescoped, not deferred — see [ADR-016](../adr/016-qa-results-come-from-the-code-repository-not-the-pm-tool.md). |
| 1834 | Results fetched incrementally by polling | Polling remains the contract; inbound webhooks **accelerate** it rather than replacing it, and Fabric does not register provider webhooks on the customer's behalf — see [ADR-010](../adr/010-qa-pull-based-ingestion-with-webhook-acceleration.md) and [ADR-011](../adr/011-fabric-does-not-register-provider-webhooks.md). |
| 1688 | "Create **or** connect the client's test repository" | Fabric only **connects**. It never creates repositories, commits workflow files, or pushes to a customer's repository; the CI snippet generator hands over text for a person to commit and says so on screen. |
| 1641 | Tiers named light / standard / enterprise | **There are two tier systems, and the card describes both at once.** `Project.qaStrategyLevel` is `LIGHT \| STANDARD \| STRICT` — the card's names, near enough — and sets how deep a generated **QA Strategy document** and the feature QA analysis go. `ProjectQaSettings.strategyDepth` is `EASY \| AVERAGE \| HARD` and sets how deep **test-case drafting** goes. Different artifacts, different settings pages: the first lives on Settings ▸ AI Assistant, the second on Settings ▸ Testing. Neither is a rename of the other, and an earlier revision of this table wrongly implied the card's names were simply not adopted. |
| 1641 | "Configurable update frequency for automated document refresh (per-deployment, daily, weekly)" | Configurable refresh **exists** and predates the card — `DocumentAutoRefreshSettings.cadence`, swept by `documentRefreshDispatcherWorkflow`. It is scoped **per document** (opt-in enrollment), not per project. All three cadences the card names are built: `ON_DEPLOY \| DAILY \| WEEKLY \| BIWEEKLY \| MONTHLY`. Per-deployment is not a schedule at all — a successful CI run on the branch Fabric watches for test results marks every `ON_DEPLOY`-enrolled document in that project due (`sync-pipeline-results.ts`). See [ADR-009](../adr/009-scheduled-ai-document-refresh-proposes-by-default.md) for why a refresh proposes rather than writes. |

### Not built

| Card | Status |
|---|---|
| 1642 | **Design-pattern compliance**, the one perspective the card names that has no implementation. "Compliance" presupposes a record of which patterns the codebase requires, and none exists; inventing a manifest would mean the lens reports the manifest's opinion rather than the repository's. The rest of the card is built — see below. |

**Three entries were removed from this table because they were wrong, and each was wrong in a way worth recognising.**

**1642 was listed as entirely unbuilt.** That was accurate when written: the card asks to *extend* an existing AI PR reviewer and no such reviewer existed — a seeded prompt with no consumer, a commented-out workflow template, a deprecated preset. It was then built from scratch, both halves: the product lenses that review a customer's pull request, and a CI reviewer on this repository's own pull requests. The entry survived the build because nobody re-read the table.

**1641's "no approval-count mechanism exists anywhere in the codebase" was false when written.** The gate was fully implemented, enforced on the transition into Done, and covered by five tests. What was missing was a *control* to set the threshold — a different claim entirely, and the one that mattered, because without it the gate could never fire. Searching for the feature's behaviour would have found it; searching for a settings control would have found the real gap.

**1641's "per-deployment document refresh is not built" was false.** `ON_DEPLOY` exists and is not a schedule: a successful CI run on the watched branch marks enrolled documents due. The mistake was looking for a deploy *cadence* in a sweep that is elapsed-time by design.

The shape all three share: a statement about absence, made by looking in one place. Absence is the hardest thing to establish and the easiest to assert.

</Callout>

### Built on top

None of these were asked for by the six cards; all are load-bearing now.

- **Findings** — a recurring failure gets a stable identity, so "this has broken
  eleven times" is visible. With merge, dismiss, and one-click promote to bug.
- **Fabric-driven runs** — Fabric drives a real browser through a case against a
  project environment, with a cost guard, staged per-case results, durable
  batching for runs of any size, and cancellation.
- **Mode B scripted runs** — a saved, validated Playwright action plan replayed
  with zero model calls, with version history, diff, and restore.
- **QA open-questions log** — testing ambiguities as queryable records rather
  than prose buried in an analysis.
- **Sceptic roles** — adversarial personas that append cases during planning;
  their cases arrive `PROPOSED`, never straight into the suite.
- **Test-case drift** — a case drafted from a criterion that later changed is
  detected and offered an update path, instead of silently asserting a flow the
  product no longer has.
- **QA document types** — test plan, test report, and traceability matrix.
- **Traceability matrix and coverage rings** — per-case pyramid level, evidence,
  and a stale flag, measured against the project's coverage target.

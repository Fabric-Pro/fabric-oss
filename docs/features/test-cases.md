# Test Cases

The project **QA** tab (displayed in-page as "Quality Assurance") — authored, ADO/TestRail-style test cases with ordered Action + Expected steps that sync to a team's PM tool, group into plans, link to the work they verify, and feed the project AI as context.

- **Audience**: Engineers extending or maintaining the QA / test-cases feature
- **Owner**: Projects / Platform team

## Overview

Each project has a **QA** tab with five segments — **Cases**, **Plans**, **Features**, **Runs** and **Questions**. A test case is *authored* (not derived from a run): it carries an ordered list of **Action + Expected** steps plus a lifecycle `state` (`PROPOSED`, `DRAFT`, `READY`, `CLOSED`), a `priority` (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), an owner, and tags. Cases are identified per project as `TC-001`, `TC-002`, …; plans as `TP-001`, `TP-002`, …

Four capabilities make a test case more than a checklist row:

1. **PM sync that rides the generic MCP engine** — a case pushes to and pulls from the same project-management tools features sync to (Azure DevOps, Jira, GitLab, Fizzy), with no per-tool fork. Steps land in the work-item body for every tool; Azure DevOps additionally gets native `Microsoft.VSTS.TCM.Steps`.
2. **Work-item linking** — a case links to a Feature/Bug, optionally to a specific acceptance criterion ("Covers AC N"), shown from both sides. The feature gets a read-only "tested by N cases" rollup.
3. **Test plans** — a plan holds cases directly (flat Plan → Cases, optional per-row section label); a case can belong to many plans. Plans are Fabric-local in v1 (not PM-synced).
4. **AI awareness** — every case is mirrored into the project's RAG store so the AI assistant takes it into account, exactly like Architecture Decisions. An optional "Generate test cases with AI" assist drafts editable cases from a feature's acceptance criteria.

> Naming note: the user-facing "Feature `F-XXX`" maps to the backend `UserStory` model. A test case's `TC-NNN` identifier is its own per-project sequence (see `generateTestCaseIdentifier`), and a work-item link joins a `TestCase` to a `UserStory`.

> Scope note: this page covers **authoring and sync**. Execution shipped separately and has its own documentation — Fabric both ingests what a customer's CI reports ([pipeline results](../qa/pipeline-results.md)) and runs a case itself by driving a browser ([Fabric-driven runs](../qa/agentic-runs.md)). `TestCase.automationStatus` is no longer a forward hook: it drives the linkage cascade that matches an automated test to its case, and the coverage figures on the QA tab. `TestCaseStep.data` and `TestCaseStep.sharedStepId` do still carry no logic.

## Architecture

```
┌── UI (apps/web/modules/saas/projects/components/test-cases) ──────────────┐
│  TestCasesList (Cases | Plans) · TestCaseEditorSheet · StepEditor          │
│  WorkItemLinkControl · TestPlansList · TestPlanDetail · TestCaseStatusChip  │
│  AiDraftDialog · use-test-cases-view                                       │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ oRPC  (orpc.projects.testCases.*)
┌───────────────▼── API (packages/api/modules/projects) ───────────────────┐
│  procedures/test-cases/*   (CRUD, steps, links, plans, ai-draft, coverage) │
│  procedures/test-cases/sync/*  (bulk push/pull, import, capabilities, …)    │
│  lib/test-case-context.ts  (mirror case → RAG)                             │
│  lib/resolve-pm-target.ts  (REUSED verbatim — same target stories use)     │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ Temporal client.workflow.start(...)
┌───────────────▼── Temporal (packages/temporal/src) ──────────────────────┐
│  workflows/test-case-sync-workflow.ts  (testCaseSyncWorkflow)              │
│  activities/pm-integration/test-case-sync.ts                              │
│     getTestCasesToSync · createOrUpdateTestCaseFromPMItem ·                │
│     buildTestCaseDescription · formatTestCaseStepsForProvider             │
│  workflows/context-embedding.ts → activities/context-embedding.ts (REUSED) │
└───────────────┬───────────────────────────────────────────────────────────┘
                │
┌───────────────▼── Data + RAG (packages/database + packages/rag) ─────────┐
│  TestCase (+Step) · TestPlan (+PlanCase) · TestCaseWorkItemLink            │
│  ProjectContext(type=TEST_CASE)  — the AI-readable mirror → Qdrant         │
│  PmSyncLog(entityType="TEST_CASE")  ·  PmStateChangeEntityType += TEST_CASE │
└───────────────────────────────────────────────────────────────────────────┘
```

## Data model

Defined in `packages/database/prisma/schema.prisma`. The two top-level tables (`TestCase`, `TestPlan`) mirror `ArchitectureDecision`: tenant XOR columns, soft-delete, a per-project unique `identifier`, and a soft `contextId` pointer to the RAG mirror. The three child tables mirror `StoryTask`: no tenant columns, reachable only through their parent via FK cascade.

| Model | Purpose |
|-------|---------|
| `TestCase` | The case. Holds `identifier` (`TC-NNN`), `title`, `description` (preconditions/summary), `state`, `priority`, `ownerId`, `tags[]`, `automationStatus` (drives the linkage cascade and the coverage figures — see the scope note above), `order` (fractional list ordering), the PM-sync subset mirrored from `UserStory` (`externalId`, `externalUrl`, `externalMcpServerId`, `pmAutoSyncEnabled`, `lastSyncedPmHash`, `lastSyncedAt`, `lastPmSyncStatus`, `lastPmSyncError`, `lastPmSyncAttemptAt`), `contextId` (soft pointer to the RAG mirror), and `deletedAt`. |
| `TestCaseStep` | An ordered step: `order`, `action`, `expected`, plus the unused-in-v1 hooks `data` (parameters) and `sharedStepId` (shared steps). `onDelete: Cascade`. |
| `TestPlan` | A plan: `identifier` (`TP-NNN`), `name`, `description`, `state` (`ACTIVE`/`INACTIVE`), `order`, `deletedAt`. No external/sync columns — plans are Fabric-local. |
| `TestPlanCase` | Membership join with optional `section` and `order`. Unique `(planId, testCaseId)` — a case can be in many plans, but only once per plan. `onDelete: Cascade`. |
| `TestCaseWorkItemLink` | Links a case to a `UserStory` with optional `acceptanceCriterionRef` ("Covers AC N") and `linkType` (default `"TESTS"`). Unique `(testCaseId, userStoryId)`. `onDelete: Cascade`. |

Two adjacent rows complete the picture:

- **`ProjectContext` with `type = TEST_CASE`** — the AI-readable mirror of a case (see *AI awareness* below). The case's `contextId` is a *soft* pointer (no FK cascade); deleting a case must also delete its `ProjectContext` and Qdrant vector.
- **`PmSyncLog` with `entityType = "TEST_CASE"`** — the push/pull audit row. `PmSyncLog.entityType` is a plain `String` column, so adding test cases needs no Prisma migration there — the activities just pass `"TEST_CASE"`.

New enums: `TestCaseState`, `TestCasePriority`, `AutomationStatus`, `TestPlanState`. Two enum members are added for forward-compat: `ProjectContextType.TEST_CASE` (the RAG type label) and `PmStateChangeEntityType.TEST_CASE` (Review-Center drift records).

### Tenant isolation

Every query follows the project XOR pattern — `organizationId` set for org context, `organizationId: null` for personal — and `test_case` / `test_plan` carry RLS policies (`user_owned`) registered in `scripts/apply-rls-direct.ts` and `src/tenant-db.ts`. The child tables carry no tenant columns and no RLS row; they are reachable only through their parent, matching the `story_task` convention. A personal-context case is invisible in org context and vice-versa.

## Key flows

### 1. Author a case + steps

`TestCaseEditorSheet` (a slide-out `@ui/components/sheet`) → the create/update procedures under `procedures/test-cases/`. New cases get their identifier from `generateTestCaseIdentifier(projectId, tx)` (reads the latest `TC-NNN` and increments, zero-padded to 3 digits, inside the create `$transaction` with a `P2002` retry loop and the `@@unique([projectId, identifier])` backstop). Steps are child rows edited in `StepEditor` (ordered Action/Expected cells, drag-and-keyboard reorder via `@dnd-kit`). On update, the procedure performs a **full step replace** (delete removed ids, upsert by id, re-`order`), so the editor always emits the complete ordered `steps[]`.

### 2. PM sync — push, pull, and the step serializer

This is the path that satisfies "sync them like work items, for every current PM tool and every future one."

- **Drive.** `procedures/test-cases/sync/sync-test-cases-bulk.ts` resolves the target with the **reused** `resolvePmTarget({ project, userId, organizationId })` (the same resolver stories use — no per-tool fork) and starts `testCaseSyncWorkflow` on the **`ai-chat`** task queue (the queue `storySyncWorkflow` runs on; the worker bundles every `workflows/index.ts` export onto every queue).
- **Workflow.** `testCaseSyncWorkflow` is a copy/parameterization of `storySyncWorkflow` with `testCaseIds?` replacing `storyIds`/`statusIds`. It reuses the entity-agnostic activities (`listWorkItemsFromPM`, `fetchPMItemsByIds`, `discoverPMToolCapabilities`, `detectAndStampPmPushConflict`) and adds `getTestCasesToSync` / `createOrUpdateTestCaseFromPMItem` / `updateTestCaseExternalRefs`. New command-producing logic is gated behind `patched("test-case-sync-v1")`; the workflow holds no wall-clock (`Date.now()`/`new Date()` live in activities and at the API start-site), keeping replay deterministic.
- **Push.** The push branch builds the work-item payload from `buildTestCaseDescription(testCase)` — title, preconditions, and an ordered, human-readable `1. Action — Expected` block — so **every** tool gets the steps in the issue body. This is the generic baseline. `formatTestCaseStepsForProvider(testCase, toolKey)` then adds the provider-specific extra: for Azure DevOps (`toolKey === "azure-devops"` with capability `supportsNativeSteps`) it emits `Microsoft.VSTS.TCM.Steps` XML onto the create `fieldsArray` / update JSON-Patch — exactly where a Bug's `Microsoft.VSTS.TCM.ReproSteps` mirror is done. Every other tool gets no extra field (steps are already in the description). **All provider branching lives inside the serializer**, so a new tool plugs in without touching the workflow.
- **Pull.** The pull branch calls `createOrUpdateTestCaseFromPMItem`, which finds a case by `(projectId, externalId)` and updates it or creates one, maps title/description, parses steps back (ADO `Microsoft.VSTS.TCM.Steps` XML → steps; generic → description plus a best-effort delimited-block parse), stores `lastSyncedPmHash`, and writes a `pull` `PmSyncLog{entityType:"TEST_CASE"}`.

### 3. Drift, retry & dismiss

On push, when both sides changed, the sync does **not** write a `PendingPmStateChange`; it stamps `lastPmSyncStatus = CONFLICT` via the shared `stampPmSyncConflict(itemType, …)` — the same mechanism the Roadmap uses. The shared PM-state activities (`record-pm-sync-state.ts`, `hierarchy-sync.ts`, `detect-pm-push-conflict.ts`) gain an internal `testCase` branch alongside `userStory`; the existing story-sync call shape is untouched. A `CONFLICT`/`FAILED` case surfaces a **Retry** (re-runs the single item through the shared `retryPmSyncItem` lib with `itemType:"testCase"`) and **Dismiss** (`clearPmSyncFailure(s)` testCase branch) control in the editor. Extending the hourly inbound terminal-state poll to test cases is out of v1 — the `PmStateChangeEntityType.TEST_CASE` member is added for forward-compat only.

### 4. AI awareness — making the AI consider cases

Type-agnostic retrieval over the shared project-context RAG store, identical in shape to Architecture Decisions:

1. On create/update/clone/import/AI-draft, `syncTestCaseContext` (`packages/api/modules/projects/lib/test-case-context.ts`) upserts a `ProjectContext` of `type = TEST_CASE`, keyed on the case's stored `contextId` (create vs update). Its content is built by `buildTestCaseContextContent` — a plain-text render of `TC-NNN <title>`, state, priority, preconditions, numbered steps (`1. <action> → <expected>`), linked feature(s) (`Covers AC N` when set), and tags.
2. It starts `contextEmbeddingWorkflow` (Temporal, task queue `project-documents`) when the content is non-empty → `embedSingleContextActivity` → a vector in the project's Qdrant collection, scoped by `projectId` + tenant.
3. At answer time, `retrieveProjectContexts` returns the most similar project contexts **with no type filter** — so test cases surface alongside decisions, documents, and meeting transcripts. No test-case-specific retrieval code exists or is needed.

On delete, `removeTestCaseContext` starts `contextDeletionWorkflow` (same queue) to drop the Qdrant point, with `deleteContext(contextId)` as a fallback. Because `contextId` is a soft pointer, deletion never relies on a DB cascade for the RAG mirror.

### 5. Generate test cases with AI

`AiDraftDialog` → `procedures/test-cases/ai-draft-test-cases.ts`. The procedure loads the feature's `title`/`description`/`acceptanceCriteria`, resolves the model through the project provider with `getAIModelWithMetadata({ taskType: "COMPLEX" }, { userId, organizationId })` (usage-tracked via `trackUsage()` / `logModelUsageAsync`, no hardcoded provider/model), and calls `generateObject` with a **lenient** schema — strings only, no `z.enum`/`z.preprocess` (those break the AI gateway with "Schema type is missing"). `normalizeDraftedTestCases` then drops empty titles/steps, trims, caps the count, and forces `state: DRAFT`, `priority: MEDIUM`, `automationStatus: NOT_AUTOMATED` in code. Each normalized case is persisted with `createTestCase`, linked to the source feature with `linkTestCaseToWorkItem`, and mirrored with `syncTestCaseContext`. **Invariant: AI output is `DRAFT` only — never `READY`/`CLOSED`.** The user reviews and promotes.

### 6. Work-item link & coverage rollup

`WorkItemLinkControl` searches features via `orpc.projects.stories.list` and links a case to a `UserStory` (the link-work-item procedure verifies the story belongs to the project), optionally tagging an `acceptanceCriterionRef`. The link shows from both sides: on the case (its linked features) and on the feature workspace (`stories/StoryWorkspace.tsx`), which renders a small read-only **"Tested by N cases"** line backed by `countTestCasesForStory` via `orpc.projects.testCases.coverageForStory`. This is the light rollup — not a coverage engine.

## File map

| Concern | Location |
|---------|----------|
| UI components | `apps/web/modules/saas/projects/components/test-cases/` |
| View hook | `…/test-cases/use-test-cases-view.ts` |
| Tab wiring + coverage line | `…/projects/components/ProjectDetails.tsx`, `…/components/stories/StoryWorkspace.tsx` |
| API procedures (CRUD, links, plans, ai-draft, coverage) | `packages/api/modules/projects/procedures/test-cases/` |
| Sync procedures (bulk, import, capabilities, retry, dismiss) | `…/procedures/test-cases/sync/` |
| Router registration | `…/modules/projects/router.ts` (`testCases:` key) |
| AI-context RAG mirror | `packages/api/modules/projects/lib/test-case-context.ts` |
| Queries (cases/steps/links, plans, identifiers) | `packages/database/prisma/queries/projects/test-cases.ts` (authoring / CRUD), `…/test-case-list.ts` (filters, sort, list), `…/test-case-results.ts` (run results + rollups), `…/test-case-bulk.ts`, `…/test-case-pm-sync.ts`, `…/test-plans.ts` |
| Schema models | `packages/database/prisma/schema.prisma` (`TestCase*`, `TestPlan*`) |
| Permissions | `packages/permissions/lib/permissions.ts`, `roles.ts` (`TEST_CASE_*`) |
| Sync workflow | `packages/temporal/src/workflows/test-case-sync-workflow.ts` (`testCaseSyncWorkflow`) |
| Sync + serializer activities | `packages/temporal/src/activities/pm-integration/test-case-sync.ts` (`formatTestCaseStepsForProvider`, `buildTestCaseDescription`, `createOrUpdateTestCaseFromPMItem`) |
| AI drafting prompt + normalizer | `packages/ai/lib/prompts/test-case-drafting.ts` |
| Embedding workflow/activity (reused) | `packages/temporal/src/workflows/context-embedding.ts`, `…/activities/context-embedding.ts` |
| i18n | `packages/i18n/translations/en.json`, `de.json` (`projects.testCases`) |

## Extending / common tweaks

- **Add a test-case field** — add it to `schema.prisma` (`TestCase`), regenerate (`pnpm --filter @repo/database generate`), thread it through `createTestCase`/`updateTestCase`, the create/update procedures, and `TestCaseEditorSheet`; and — if the AI should see it — include it in `buildTestCaseContextContent` so it lands in the RAG mirror.
- **Add a PM tool** — nothing in the workflow changes. The generic baseline (`buildTestCaseDescription`) already serializes steps into the issue body for any MCP PM tool. Add a provider branch to `formatTestCaseStepsForProvider` only if the tool exposes a native step field worth using (as Azure DevOps does).
- **Change what the AI reads** — edit `buildTestCaseContextContent`. Content changes re-embed on the next save (the workflow re-runs); there is no separate re-index step.
- **Change what step parsing accepts on pull** — `createOrUpdateTestCaseFromPMItem` owns the "parse steps back from the provider payload" logic (ADO XML + generic best-effort). Keep the round-trip symmetric with the serializer.
- **Tune AI drafting** — the lenient schema and `normalizeDraftedTestCases` live in `packages/ai/lib/prompts/test-case-drafting.ts`. Keep the schema string-only; do the enum/default coercion in the normalizer, never in the schema.

## Operational notes

- **Determinism / replay** — `testCaseSyncWorkflow` is a new workflow with no prior histories, so `patched("test-case-sync-v1")` is benign. Edits to the shared PM-state activities are internal-only; the existing `storySyncWorkflow` call shape is unchanged, so existing-story replay is unaffected. After editing anything under `packages/temporal/`, restart the `temporal-worker` Aspire resource.
- **Deletion** — because `contextId` is a soft pointer, deleting a case must also delete its `ProjectContext` row and its Qdrant point; don't rely on a DB cascade for the RAG mirror.
- **Embedding dependency** — "AI considers cases" only works while the project's embedding provider is healthy. A case still creates and stores correctly without embeddings; only retrieval is affected until the vector lands.
- **Permissions** — one permission family (`TEST_CASE_READ`/`CREATE`/`UPDATE`/`DELETE`) covers cases **and** plans: plan, link, and sync mutations reuse `TEST_CASE_UPDATE`/`CREATE`/`DELETE`. Every procedure declares its permission via `requireProjectPermission(...)`; a coverage test enforces it.

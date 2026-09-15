# Inverted Loop: Engagement Profiles, Delivery Tracks, Spike and Discovery Runs

Engineering plan for engagement profiles, delivery tracks and the inverted delivery loop (idea → build → play → design → ship → learn); §10 records what landed and how it deviates.

- **Audience**: engineers and product managers working on backlog intake, delivery tracks, spikes, discovery runs, estimates and customer outcomes
- **Owner**: Platform

**Status:** v3.1 approved for implementation. **Branch `feat/inverted-loop-delivery-tracks` implements every slice: §2 Foundation F1–F4, Slices 0–8.** See §10 for implementation notes and deviations.
**Date:** 2026-09-14 (v3 same day, after two independent review rounds)
**Companion:** product plan "Fabric and the Inverted Loop" (PDF shared with Product Management).
**Source article:** Josh Elman, "Product Management is Still All About Telling Stories," a16z.news, 2026-09-14.
**Review history (implementation):** nine read-only review rounds by GPT-5.6 Sol on branch `feat/inverted-loop-delivery-tracks`; rounds 1–5 BLOCK with fixes applied and re-verified each time, round 6 PASS for staging after human review with three named staging risks, rounds 7–8 BLOCK while those risks were closed, round 9 PASS. Review transcripts are not kept in this repository (iteration records); the findings are summarised in §9 and §10. Round-9 staging notes: deploy migration `20260914200000_proposal_application_key` before the worker; exercise real concurrent retries (unit tests mock the P2002 metadata); watch replay across the two `patched()` gates. The three staging risks the reviewer named at PASS (non-atomic application record for Teams proposals without `sourceRef`; deployment-time non-determinism for in-flight backlog apply workflows; guests unable to read the parent `project` row under enforced RLS) were subsequently addressed; see §10. **Sprint 3–6 (Slices 3, 4, 6, 7, 8):** reviewed separately; round 1 BLOCK (five required fixes, two fidelity items), round 2 BLOCK (four residuals), round 3 BLOCK (contract-status race and error mapping), round 4 PASS for staging after human review; fixes applied after each; findings summarised in §10. Mandatory staging pre-deploy step accepted by the reviewer: replay a real pre-change implement `codingRunWorkflow` history against the new worker before deploying it.

**Review history (plan):** v1 and v2 reviewed by GPT-5.6 Sol (high) in read-only mode. Round 1: BLOCK, 10 factual + 8 design findings. Round 2: BLOCK, 9 findings on v2 (mostly migration SQL, transaction composition, status propagation, frame predicates). Round 3 on v3: BLOCK on three textual items (index placed before its table, one snake_case identifier, stale 'row lock' wording), applied verbatim in v3.1. Every finding was verified against `main` before being applied; §9 holds both disposition tables.

---

## 0. Why this exists

Elman's argument: building has become cheap enough that a prototype is a better way to discover what the spec should say than writing the spec first. The old loop was idea, spec, design, build, ship, learn. The new one is idea, build, play with it, design, ship, learn. He is explicit that this does not remove judgment: "Demos are almost free now. Working products are not." Design, in his words, is "both senses: visual and UX design, and also engineering design," and it happens after you have played with the thing. He also names what does not change: a vision stated as purpose, core actions, and cycle; onboarding; reading transcripts yourself; and retention as the report card.

Fabric on `main` is the old loop, structurally. Document tiers require a PRD before architecture and architecture before features (`apps/web/modules/saas/projects/components/wizard/documents.ts:19-27`). The feature drafting ladder ends at "Ready for Dev" (`apps/web/modules/saas/projects/lib/stories/types.ts:321-377`). Coding runs terminate at `PR_OPENED` (`packages/database/prisma/schema.prisma:7483-7492`) and the prompt never asks for anything a human can touch (`packages/temporal/src/activities/coding-run/index.ts:349`). Nothing produces a preview. Learning is delivery hygiene, not usage. And there is no validation of drafting-stage transitions at all: `PUBLISHED` requires nothing today (`packages/database/prisma/queries/projects/stories.ts:826`).

The enterprise objection is valid and is handled by separating two kinds of unknowns. Product and feasibility unknowns are answered by building and playing. System unknowns (auth, tenancy, external systems, regulated data) are answered by inspection, not by prototyping and not by drafting. This plan adds a **delivery track** per work item, an **engagement profile** per project, and two new run kinds, **Spike** and **Discovery**, alongside today's implementation run. Traceability, PM sync, standards, and tenant isolation are preserved; several of them are tightened because the review found gaps that exist today.

---

## 1. Target model

### 1.1 Delivery track (on `UserStory`)

| Track | Classify when | Gate before `PUBLISHED` ("Ready for Dev") | Run |
|---|---|---|---|
| `SPIKE` | Feasibility or desirability unverified; novel AI/UX; answer changes scope or estimate | An accepted Spike run (findings applied, play notes recorded), then description + acceptance criteria | Spike run: demo + findings, no PR |
| `DISCOVERY` | Touches auth, authz, tenancy, external system, regulated data; depends on an unconfirmed API | An `INTEGRATION_CONTRACT` document for the story in `COMPLETE` status | Discovery run: contract + open questions |
| `SPECIFY` | Deterministic rules, calculations, CRUD with known inputs; customer already specified it | Description + acceptance criteria. **New requirement**: today `PUBLISHED` requires nothing | Implementation run: PR, as today |
| `DEFER` | Explicitly out of scope, or outside the engagement's quoted horizon, or blocked by an undecided dependency. **Phase alone never implies DEFER** | Cannot start. No documents generated | none |
| `UNCLASSIFIED` | Default on create until classifier or human sets it | Blocked when enforcement is on, except under `GOVERNED` where it resolves to `SPECIFY` | none |

**Gates are advisory first, enforced per track by flag.** Readiness is always computed and shown. Enforcement for a track is switched on only after that track's completion path exists and is tested (§5). This is what makes slices 0–2 usable alone.

### 1.2 Engagement profile (on `Project`)

| Profile | Intake | Default track when classifier unsure | Stage transitions | Visible hierarchy | Customer surface |
|---|---|---|---|---|---|
| `EXPLORE` | Conversation (BacklogChat, spike-oriented prompt) | `SPIKE` | Free | Features only | Demos, findings |
| `PROPOSAL` | Document import + triage | classifier decides | Free | Epics + features | Estimate roll-up, demos |
| `GOVERNED` | Formal requirements import | `SPECIFY` | Every transition creates a `StageTransitionRequest`; approvers are configured; approval needs a dedicated permission | Epics + features + stories | Specs, status, change log |
| `DELEGATED` | Handoff import | classifier decides | Free | Team-internal | Token-scoped outcomes page; **no story API access for the customer audience** |

Existing rows default to `GOVERNED` because it is the closest match to today's uniform gating. This is **not** "existing projects unchanged": two behaviours change for them when the corresponding flags are turned on, and both are rolled out separately with communication (§5).

Profile changes out of or into `GOVERNED`, and approver configuration, require a new permission `PROJECT_GOVERNANCE_MANAGE` granted to owners and org admins only. Editors hold `PROJECT_UPDATE` today (`packages/permissions/lib/roles.ts:183`) and must not be able to downgrade governance.

### 1.3 Run kinds

| Kind | Where | Terminal | Evidence produced |
|---|---|---|---|
| `IMPLEMENT` (existing) | `CodingRun.kind` | `PR_OPENED` → `COMPLETED` | PR |
| `SPIKE` (new) | `CodingRun.kind` | `DEMO_READY` → `COMPLETED` on acceptance | Frame (project + story linked), findings, play notes, `FeatureVersion` |
| Discovery (new) | new `DiscoveryRun` model | `CONTRACT_READY` → `COMPLETED` | `ProjectDocument` of type `INTEGRATION_CONTRACT` linked to the story; `UserStoryComment` per open question |

Discovery is not a `CodingRun`: it has no provider and produces a document, not code.

### 1.4 Vision fields (small, from the article)

`Project` gains optional `visionPurpose`, `visionCoreActions String[]`, `visionCycle` (text). Shown on the Brief step for `EXPLORE` and `PROPOSAL`, included in classifier and spike prompts, and displayed on the outcomes page. No gate depends on them.

---

## 2. Foundation work (before any slice)

The review found that the plan's gates and approvals would be unsafe on today's data layer. These four pieces are prerequisites and are estimated separately.

### F1. Transactional `transitionStory` domain service (5 days)

**Where:** `packages/database/src/delivery/` (the readiness policy must live in `@repo/database` or a dependency-neutral package: `@repo/api` depends on `@repo/database`, not the reverse, so query functions cannot import from `@repo/api`).

```ts
// packages/database/src/delivery/readiness.ts  (pure)
export type ReadinessGap = "UNCLASSIFIED" | "DEFERRED" | "SPIKE_NOT_ACCEPTED" | "INTEGRATION_CONTRACT_MISSING"
  | "DESCRIPTION_MISSING" | "ACCEPTANCE_CRITERIA_MISSING";
export function evaluateReadiness(input: {
  story: Pick<UserStory, "deliveryTrack" | "description" | "acceptanceCriteria" | "draftingStage">;
  profile: EngagementProfile;
  enforcement: { specify: boolean; spike: boolean; discovery: boolean };
  evidence: { acceptedSpikeRuns: number; integrationContractComplete: boolean };
}): { ready: boolean; missing: ReadinessGap[]; advisory: ReadinessGap[] };

// packages/database/src/delivery/transition-story.ts  (transactional)
export async function transitionStory(params: {
  storyId; projectId; toStage; actor: { userId; organizationId? };
  patch?: { description?; acceptanceCriteria? };   // for update-stage-with-version, enhance, restore
  reason: "manual" | "enhance" | "restore" | "spike_accepted" | "discovery_complete" | "approval" | "create";
}): Promise<{ applied: true; story } | { applied: false; requestId: string }>;
```

`transitionStory` follows the repository's existing optimistic compare-and-swap pattern rather than a row lock (precedent and rationale: `packages/database/prisma/queries/project-repository-integrations.ts:289-326`, which guards with `updatedAt` and avoids `SELECT FOR UPDATE`; there is no row-lock or advisory-lock precedent in the repo). It executes with `withRLSContext(db, async (tx) => { ... })` (`packages/database/src/tenant-db.ts:599`), the repo's composable transaction helper that sets the RLS session variables; the transaction client does **not** receive `getTenantDb()`'s automatic tenant filters, so inside the callback the service first re-checks the actor's current project access (owner, or accepted non-expired `ProjectMember`, or the org-member and guest paths in `packages/database/prisma/queries/projects/projects.ts:838-891`) and required permission, and scopes every story and evidence query by `projectId` and the resolved tenant explicitly. Then: read the story (`version`, `draftingStage`, `deliveryTrack`, `description`, `acceptanceCriteria`) and its evidence; evaluate readiness; then `updateMany({ where: { id, version: expectedVersion, draftingStage: fromStage }, data: { draftingStage, draftingStageUpdatedAt, version: expectedVersion + 1, ...patch } })` and require `count === 1`, writing the `FeatureVersion` snapshot in the same transaction. `count === 0` means a concurrent writer won; re-read once and re-evaluate, then fail with `CONFLICT`. `UserStory.version` already exists and is bumped by the version-aware procedures, so this guard composes with them. Under `GOVERNED` the service records a `StageTransitionRequest` instead and returns `applied: false`. It throws `ReadinessError { missing }` when enforcement blocks; API procedures map it to `PRECONDITION_FAILED`.

**Every stage writer routes through it** (all verified on `main`):
- `update-drafting-stage.ts`, `update-drafting-stage-with-version.ts`
- `update-story.ts:45-50, 93` (generic update accepts `draftingStage`; the field is kept but delegated)
- `enhance-feature.ts:336-346`
- `create-story.ts` when creating at `PUBLISHED`; the agent built-in `fabric_create_story` (`packages/temporal/src/activities/direct-chat/built-in-tools.ts:644-834`) creates at `PLACEHOLDER` today and any future ability to create at `PUBLISHED` must route through `transitionStory`. (v2 named a non-existent MCP tool `fabric_create_feature`; the gateway has `fabric_create_feature_task`, which creates tasks, not stories.)
- `restoreFeatureVersion` (`packages/database/prisma/queries/projects/feature-versions.ts:87-158` writes `draftingStage` from the restored version)
- spike acceptance and discovery completion (new)
- `review-pending-state-change.ts` / `bulk-review-pending-state-changes.ts` (write `CLOSED`; routed for consistency, never blocked)

**Run-start checks** call `evaluateReadiness` again (evidence can change after publish) inside the same transaction that creates the run row: `start-coding-run.ts`, `queue-for-kanban.ts`, `kanban/procedures/sync.ts:72` (selects every `PUBLISHED` story), `weave/procedures/create-plan.ts` and **`weave/procedures/start-execution.ts`** (execution can happen long after plan creation; neither checks the story today).

### F2. Active-run uniqueness (1 day)

`start-coding-run.ts:122-170` checks for an active run and then inserts in separate statements; two clicks can create two runs. Add partial unique indexes in raw migration SQL (Prisma has no native partial unique; precedent with quoted camelCase identifiers: `packages/database/prisma/migrations/20260505120000_add_ado_state_polling/migration.sql:46-49`). Prisma maps the table name but keeps camelCase column names, so identifiers must be quoted exactly:
```sql
CREATE UNIQUE INDEX "coding_run_one_active_per_story"
  ON "coding_run" ("storyId")
  WHERE "status" IN ('QUEUED','STARTING','RUNNING','AWAITING_REVIEW','PR_OPENED','DEMO_READY');

```
The same pattern applies to tables created later, in **their own** migrations (not in F2, since the tables do not exist yet): `stage_transition_request("storyId") WHERE "status" = 'PENDING'` in slice 5 and `discovery_run("storyId") WHERE "status" IN ('QUEUED','RUNNING','CONTRACT_READY')` in slice 4. Catch `P2002` → `CONFLICT`. **Weave:** `userStoryId` lives on `WeavePlan` (`schema.prisma:7800`), not `WeaveExecution` (`planId`, `projectId` only). Add a nullable denormalised `userStoryId` to `WeaveExecution`, populated from the plan in the execution-creation transaction, and index `weave_execution("userStoryId")` partially on active statuses. **Preflight:** F2 covers existing tables only (`coding_run`, `weave_execution`); its migration is preceded by a duplicate check script that lists and remediates rows that would violate each unique index (there is no protection today, so duplicates may exist).

### F3. Proposal approval claiming and idempotent apply (3 days)

`markPendingProposalApproved` is an unconditional update by id (`packages/database/prisma/queries/projects/pending-backlog-proposals.ts:129-135`); `appendAppliedChangeIndexes` is read-modify-write (`:110-127`); a crash between story create and index append duplicates the story on retry.
- Add status `APPLYING` to `PendingBacklogProposalStatus` (`schema.prisma:1813-1820`). Generate the deterministic `applyWorkflowId` **before** claiming; claim with `updateMany({ where: { id, status: { in: ["PENDING","FAILED"] } }, data: { status: "APPLYING", applyWorkflowId } })` and require `count === 1`. Every subsequent apply, finalisation, failure, retry, and cancellation update includes `where: { status: "APPLYING", applyWorkflowId }` so only the claimant can advance the row. Today's finaliser appends indexes and flips terminal status with no ownership check (`packages/temporal/src/activities/teams-channel-monitor/fetch-channel-cursor.ts:154-170`); it adopts the protocol. Both CREATE and UPDATE changes move behind the claimant workflow.
- `APPLYING` must propagate to: generated Zod; both Teams status schemas (`teams-channel-monitor/list-pending-proposals.ts:14-21`, `teams-chat-monitor/list-pending-proposals.ts:16-23`); the inbox union and queries (`PendingBacklogProposalsInbox.tsx:51-57, 145-154`); in-flight counts that treat `APPROVED` as active (`count-pending-proposals.ts:29-34`); Daily Brief schema and collector (`daily-brief-schema.ts:148-153`, `collect-teams-proposals.ts:31-40`).
- New table `pending_backlog_proposal_application (proposal_id, change_index, created_entity_type, created_entity_id, unique(proposal_id, change_index))`. Each change is applied and recorded in one transaction. `appliedChangeIndexes` stays as a denormalised mirror written in the same transaction for one release; its readers are `approve-pending-proposal.ts` (teams-channel-monitor), `packages/temporal/src/workflows/backlog-apply-changes-workflow.ts`, and `packages/temporal/src/activities/teams-channel-monitor/fetch-channel-cursor.ts`, all of which switch to the application table before the column is dropped. The Teams approve path adopts the same claim protocol.
- Partial unique indexes have precedent in `20260505120000_add_ado_state_polling/migration.sql:46-49` and `20260423015157_add_daily_brief/migration.sql`.
- Partial unique so a retried import cannot create a second `VIS-02`:
```sql
CREATE UNIQUE INDEX "user_story_project_source_ref_uq"
  ON "user_story" ("projectId", "sourceRef") WHERE "sourceRef" IS NOT NULL;
```

### F4. Provider capability proof for spikes (3 days, time-boxed)

Artifact sync recognises only `pull_request` (`coding-run/index.ts:404-425`), is treated as non-critical in the workflow (`coding-run-workflow.ts:295-304`), and the local provider returns only a worker-local `local_runtime` artifact (`local-kanban-provider.ts:442-476`). Before slice 3 is estimated further, prove for **each** provider that a session can push a named branch `fabric-spike/<runId>` to the project repository without opening a PR, and that Fabric can read files from it via `getGitHubToken` + `fetchFileContent(token, { owner, repo, path, ref })` (`packages/integrations/src/github/index.ts:1148-1175`). Outcome is recorded as a provider capability `pushBranchWithoutPr: boolean` on the provider interface (`packages/temporal/src/lib/coding-execution/types.ts`). Providers without it do not offer spikes. If neither provider can, slice 3 falls back to a provider artifacts API (`type: "file"`) and its estimate is redone.

---

## 3. Cross-cutting rules

1. **Tenant isolation.** New tables carry `userId`/`organizationId`, use the XOR filter, are registered in `packages/database/src/tenant-db.ts`, and get RLS in `packages/database/scripts/apply-rls-direct.ts`. Frames need a **new** access class (§ slice 3), not just a column.
2. **Enum triplication.** Prisma enum → regenerate Zod (`pnpm --filter @repo/database generate`, runs `fix-zod-imports.ts`) → hand-maintained UI unions (`lib/stories/types.ts:311`, `PendingBacklogProposalsInbox.tsx:51`, `BacklogChangeProposal.tsx:22-43`, coding-run status labels).
3. **Migrations** via `prisma migrate dev`; additive only; raw SQL blocks for partial unique indexes.
4. **Permissions.** New keys `PROJECT_GOVERNANCE_MANAGE = "project:governance:manage"` and `STORY_STAGE_APPROVE = "story:stage:approve"` follow the `<domain>:<resource>:<action>` rule in `permissions.ts:1-6`; granted to owner and org-admin roles in `roles.ts`. Constants and the role matrix are separate sources of truth, and `permission-coverage.test.ts` only proves a procedure declares a valid key, so add explicit **matrix tests** asserting which roles hold and lack the two new keys. Document the override behaviour in `packages/api/orpc/middleware/require-permission.ts:188-224`: an org admin who holds an active project-level Viewer role loses governance rights on that project; this is intended.
5. **oRPC depth ≤ 3** (`projects/router.ts:476-478`).
6. **Temporal.** Barrel exports; existing task queues; `codingRunWorkflow` change branches only on new input fields that are `undefined` in old histories; replay test fixture added; worker restart after changes.
7. **AI dialogs preflight the provider** (`aiConfig.resolution.getStatus`).
8. **Fail closed.** Readiness returns not-ready on any lookup error; spike sync never reaches `DEMO_READY` without a frame; discovery never reaches `CONTRACT_READY` without a document.
9. **Prompt injection.** Customer documents and repository content are untrusted. Scope extraction and classification prompts wrap document text in delimited data blocks, instruct the model to ignore instructions inside them, and post-validate outputs against the Zod schema and an allowlist of enum values. Spike prompts state that repository content is data.
10. **Flags.** `apps/web/modules/saas/projects/lib/delivery-tracks-flags.ts` for UI surfaces; **project-level** enforcement flags (`enforceSpecifyGate`, `enforceSpikeGate`, `enforceDiscoveryGate`, `documentTiersAdvisory`) stored on `Project`, default off for existing rows.
11. **i18n** keys in `packages/i18n/translations/en.json` / `de.json`.

---

## 4. Slices

Order: **F1–F4 + Slice 0** (Sprint 1), **Slices 1, 2, 5-advisory** (Sprint 2), **Slices 3 and 4 in parallel** (Sprints 3–4), **enforce gates**, **Slices 6, 7** (Sprint 5), **Slice 8 reduced** (Sprint 6). Sizes are engineer-days excluding review.

---

### Slice 0. Engagement profile, governance permissions, vision fields (6 days)

**Schema**
```prisma
enum EngagementProfile { EXPLORE PROPOSAL GOVERNED DELEGATED }
model Project {
  engagementProfile          EngagementProfile @default(GOVERNED)
  engagementProfileUpdatedAt DateTime?
  quotedPhases               String[] @default([])   // e.g. ["1"]; used by DEFER rule under PROPOSAL
  enforceSpecifyGate         Boolean @default(false)
  enforceSpikeGate           Boolean @default(false)
  enforceDiscoveryGate       Boolean @default(false)
  documentTiersAdvisory      Boolean @default(false)
  visionPurpose              String? @db.Text
  visionCoreActions          String[] @default([])
  visionCycle                String?
  approvers                  ProjectStageApprover[]
}
model ProjectStageApprover { projectId; userId; createdAt; @@id([projectId, userId]) @@map("project_stage_approver") }
```
Migration `project_engagement_profile_and_governance`.

**Shared config** `packages/database/src/engagement-profiles.ts`: `ENGAGEMENT_PROFILES: Record<EngagementProfile, { defaultTrack; stageTransitionsRequireReview; visibleHierarchy; intakeMode; wizardSteps; kanbanTemplateId }>`.

**API**
- `create-project.ts`, `save-draft-project.ts`: `engagementProfile`, vision fields, `quotedPhases`.
- `update-project.ts`: profile/flags/approvers changes require `PROJECT_GOVERNANCE_MANAGE`; other fields unchanged. Audit row on every governance change (reuse the project activity log if present; else a `ProjectGovernanceEvent` table).
- Project GET returns profile, flags, and approvers.

**Web**
- `ProjectCreationWizard.tsx:131-142`: `EXPLORE_STEPS = [Brief, Review]`; step selection at `:600` becomes profile-driven with the code-based override preserved. Profile picker and vision fields on Brief.
- Apply kanban template per profile at creation (`kanban-column-templates.ts`, `discovery` for `EXPLORE`).
- `ProjectDetails.tsx` reads `visibleHierarchy`. **UI hiding is not authorization**; the customer audience is handled in slice 8.

**Tests.** Editor cannot change profile (`FORBIDDEN`); owner can; audit row written. Draft round-trip. Existing rows read `GOVERNED` with all enforcement flags off. Wizard steps per profile.

---

### Slice 1. Scope intake from a customer document (10 days)

**Reuse.** PDF upload + extraction (`create-context-upload-url.ts:19-43`, `process-context-file.ts`, text lands in `ProjectContext.content` per `project-context-processing.ts:279-282`). Proposal inbox and apply path (`PendingBacklogProposal`, `backlogApplyChangesWorkflow`, `applyBacklogChanges` in `analyze-context.ts:896+`), hardened by F3.

**Schema**
```prisma
enum PendingBacklogProposalSource { TEAMS_CHANNEL TEAMS_CHAT SCOPE_DOCUMENT }
enum StorySource { ... IMPORTED_SCOPE }
model UserStory {
  sourceRef            String?    // customer's own line ID ("VIS-02"). Not externalId (PM-tool ID; see enqueue-pm-sync.ts:104-132)
  sourceDependencyRaw  String?    // the raw dependency cell, e.g. "P1–2"
  dependsOnRefs        String[] @default([])   // explicit item edges only, e.g. ["INT-01","INT-02"]
  dependsOnPhases      String[] @default([])   // phase-horizon dependencies, e.g. ["1","2"]
  @@index([projectId, sourceRef])
}
```
Plus the partial unique from F3. Migration `scope_intake_refs`.

**Proposal schema extension** (`analyze-context.ts:55-145`): change items gain `sourceRef`, `labels[]` (`phase:1`), `sourceDependencyRaw`, `dependsOnRefs`, `dependsOnPhases`, `sourceChangeKey` (stable key = `${contextId}:${sourceRef}` for F3 idempotency). `sourceContext` gains `"scope_document"`. Mirror in `apply-changes.ts:31-107` and `BacklogChangeProposal.tsx:22-43`.

**Dependency semantics.** The Heritage `DEP.` column holds phase horizons (`P1`, `P1–2`), not item IDs; item edges live in the "Cross-phase dependencies" section. The extractor: phase cells → `dependsOnPhases`; explicit ID lists in dependency prose → `dependsOnRefs`, attached **only** where the prose names the downstream items explicitly by ID (e.g. "INT-01/02 are prerequisites for P2 ERP, inventory, customer pricing, checkout and order submission" → `dependsOnRefs: ["INT-01","INT-02"]` on `INT-03`, `COM-01`, `QTE-04`, `COM-04`, and the phase-2 checkout lines the fixture enumerates). Where the downstream side is only an area or phase, record the edge as `dependsOnPhases`/a note, never guess items. The fixture asserts the expected edge list for INT-01 and INT-02. Raw cell always preserved.

**`applyBacklogChanges`** writes the new fields and `source: IMPORTED_SCOPE`; priority Must → `P1_HIGH`, Nice → `P3_LOW`; area prefix → Epic; each line → story at `PLACEHOLDER`, `deliveryTrack: UNCLASSIFIED`.

**Workflow** `scopeIntakeWorkflow` on `project-documents`:
1. `awaitContextExtracted(contextId)` — the **dependency mechanism** (bounded poll on `extractionStatus`, 10 min, fail with clear error). Same queue is not relied on for ordering.
2. `extractScopeItems({ text, hints })` — deterministic pre-pass (ID regex `^[A-Z]{2,4}-\d{2,3}$`, table-row detection, phase headers) seeds a chunked LLM structured-output pass; dedupe by `sourceRef`; post-validate against schema and enum allowlists (rule 9).
3. `persistPendingBacklogProposal({ source: "SCOPE_DOCUMENT", sourceMetadata: { contextId, originalFilename, rowCount } })`.

**API.** `projects.backlog.startScopeIntake` (`PROJECT_UPDATE`, idempotent `workflowId: scope-intake-${contextId}`); `projects.backlog.pendingProposals.{list,get,approve,reject}` as a generic mount of the procedures now under `projects.teamsChannelMonitor.pendingProposals` (old path aliased one release).

**Reconcile `pushToKanban`.** `push-to-kanban.ts:568-664` parses a `USER_STORY` document and creates stories directly (optionally clearing existing ones). It is a second intake path, not a run start. Under `PROPOSAL`/`GOVERNED` it is routed through the proposal inbox (produces a `SCOPE_DOCUMENT` proposal from the document instead of writing); under `EXPLORE`/`DELEGATED` it may write directly but created stories are `UNCLASSIFIED` and trigger classification. The "clear existing stories" option requires `PROJECT_GOVERNANCE_MANAGE` under `GOVERNED`.

**Web.** Contexts tab "Extract scope" on completed `DOCUMENT` contexts; inbox source badge and `sourceRef`/phase columns; `PROPOSAL` wizard offers import after creation.

**Tests.** Heritage fixture: **all 100 IDs** (`FND-01`…`REB-07`) extracted with `sourceRef`, phase labels, priorities; `dependsOnPhases` for `P1–2` cells; `dependsOnRefs` from the cross-phase section. Re-import is a no-op (partial unique + application table). `externalId` stays null; pm-sync not triggered. Crash between create and application record → retry creates nothing new. Tenant negative. `pushToKanban` under `PROPOSAL` produces a proposal, not stories.

---

### Slice 2. Classification into tracks (5 days)

**Schema**
```prisma
enum DeliveryTrack { UNCLASSIFIED SPIKE DISCOVERY SPECIFY DEFER }
enum TrackSetBy { AI HUMAN }
model UserStory {
  deliveryTrack  DeliveryTrack @default(UNCLASSIFIED)
  trackRationale String? @db.Text
  trackSetBy     TrackSetBy?
  trackUpdatedAt DateTime?
  @@index([projectId, deliveryTrack])
}
```
Migration `user_story_delivery_track`. UI: `DELIVERY_TRACK_META` in `lib/stories/types.ts`.

**Classifier** (`packages/temporal/src/activities/delivery-track/classify.ts`)
- Deterministic pre-rules: **DEFER only when** (a) title/scope note marks it out of scope, or (b) `project.quotedPhases` is non-empty **and** phase label ∉ `quotedPhases` **and** priority `P3_LOW` (an empty `quotedPhases` means "no configured horizon" and rule (b) is inactive), or (c) `dependsOnRefs` includes an item that is itself `UNCLASSIFIED`/`DEFER` and marked blocking. Phase alone never defers (EST-03 is Phase 2 and must classify `SPECIFY`). Keyword hits (`sso|oauth|auth|permission|role|tenant|erp|api|integration|pii|gdpr|hipaa|payment`) are candidates for `DISCOVERY`, confirmed by the model.
- LLM structured output per batch ≤ 25: `{ storyId, track, rationale ≤ 300 chars, confidence }`, with the §1.1 table, project description, tech stack, vision fields, and RAG hits when a repo is linked. Document text is wrapped as untrusted data (rule 9).
- Confidence < 0.6 → profile `defaultTrack` (or stays `UNCLASSIFIED` when `CLASSIFIER`); rationale prefixed "Low confidence".
- Never overwrites `trackSetBy: HUMAN`. Classification and apply cannot race: classification is started by `backlogApplyChangesWorkflow` after its last transaction commits, with the created story ids.

**Workflow** `deliveryTrackClassificationWorkflow` on `ai-chat`; triggers: after apply, `projects.stories.classifyTracks` (`PROJECT_UPDATE`), `create-story` fire-and-forget.

**API.** `projects.stories.setDeliveryTrack` (`STORY_UPDATE`) → `HUMAN`; `projects.stories.classifyTracks`.

**Web.** Track chip on `StoryCard`; selector + rationale in `StoryWorkspace`; roadmap "Group by: priority | track" (`roadmap-utils.ts` `groupStoriesByTrack`); classify button with provider preflight.

**Tests.** Pre-rule matrix incl. EST-03 (Phase 2, Must → not DEFER), PRJ-04 (Phase 3, Nice, outside quoted phases → DEFER). Human override survives re-run. Prompt contains delimiter wrapping; output failing schema is rejected.

---

### Slice 5. Track-aware gates and governed approvals (7 days) — advisory in Sprint 2, enforced later

Built on F1.

**Schema**
```prisma
enum StageTransitionRequestStatus { PENDING APPROVED REJECTED SUPERSEDED }
model StageTransitionRequest {
  id String @id @default(cuid())
  projectId String; storyId String; requestedById String; userId String?; organizationId String?
  fromStage FeatureDraftingStage; toStage FeatureDraftingStage
  patch Json?           // description/AC to apply on approval
  reason String
  status StageTransitionRequestStatus @default(PENDING)
  reviewedById String?; reviewedAt DateTime?; reviewNote String?
  createdAt DateTime @default(now())
  @@index([projectId, status]) @@index([storyId]) @@map("stage_transition_request")
}
```
Migration `stage_transition_request`, including in the same migration:
```sql
CREATE UNIQUE INDEX "stage_transition_request_one_pending_per_story"
  ON "stage_transition_request" ("storyId") WHERE "status" = 'PENDING';
```
Tenant-db + RLS registration.

**Behaviour**
- `transitionStory` under `GOVERNED` (`stageTransitionsRequireReview`) records a request and supersedes older `PENDING` requests for the same story. Applies to `DECLINED`/`CLOSED` too (closing scope is a contract change).
- Approve/reject: `projects.stories.stageRequests.{list,approve,reject}` with **`STORY_STAGE_APPROVE`**, and the approver must be in `ProjectStageApprover` (or an owner when the list is empty). Requester ≠ approver, no exceptions; a one-person project under `GOVERNED` is a misconfiguration surfaced in the UI.
- Approval re-runs `transitionStory` with `reason: "approval"` inside the same transaction that flips the request to `APPROVED` (readiness re-evaluated at approval time).
- Document tiers (`wizard/documents.ts:19-27`): when `documentTiersAdvisory`, `USER_STORY.prerequisites = []` and `getPrerequisiteHint` is advisory copy.
- Enforcement flags per track (§1.1). Readiness panel always visible; `StartWorkButton` shows gaps and is disabled only when the relevant flag is on; hidden for `DEFER`.

**Tests (fail-closed).** SPECIFY without AC blocked when flag on, allowed with flag off but shown as advisory. SPIKE/DISCOVERY gates likewise. Generic update, enhance, restore, MCP create, Weave start-execution, kanban sync, queueForKanban all blocked under enforcement (one test per writer). GOVERNED: request created, story unchanged; self-approval rejected; non-approver rejected; approval re-runs readiness and fails if evidence vanished. Concurrency: two simultaneous transitions on one story → one wins the compare-and-swap; the other re-reads and receives `CONFLICT`. Readiness returns not-ready when evidence lookup throws.

---

### Slice 3. Spike runs (14 days, after F4 passes)

**Schema**
```prisma
enum CodingRunKind { IMPLEMENT SPIKE }
enum CodingRunStatus { ... DEMO_READY }   // add
model CodingRun {
  kind          CodingRunKind @default(IMPLEMENT)
  spikeQuestion String? @db.Text
  spikeBranch   String?
  findings      String? @db.Text
  playNotes     String? @db.Text     // recorded at acceptance: who tried it, what happened, decision
  demoFrameId   String?
  demoUrl       String?
}
model AgentWorkspaceFile {
  projectId String?
  storyId   String?
  @@index([projectId]) @@index([storyId])
}
```
Migration `coding_run_spike_and_project_frames`.

**Frames become project-scoped — data-layer work, not just a column.**
- `tenant-db.ts:69` lists `AgentWorkspaceFile` as per-user and RLS applies `per_user_within_org` (`apply-rls-direct.ts:135`). The RLS script's policy vocabulary today (`user_owned`, `per_user_within_org`, `strict`, `scope`, `author_owned`, `org_only`, …) has **no project-membership policy**, so this is a new policy kind in the script, not a reuse. Add `project_scoped_or_per_user` with **explicit predicates at both layers** (application queries in `frames.ts:176-215`, which today require exact user/org ownership, and RLS in `apply-rls-direct.ts:495-519`):
  - `projectId IS NULL`: unchanged, exact `userId` + `organizationId` ownership.
  - `projectId IS NOT NULL`, read: caller is `project.userId` (owner) **or** has a `ProjectMember` row for that project with `acceptedAt IS NOT NULL AND (expiresAt IS NULL OR expiresAt > now())`. This covers org members and project-scoped guests identically; same-org non-members are denied. The RLS predicate is a correlated `EXISTS` on `project` and `project_member` using the session user id.
  - `projectId IS NOT NULL`, write: owner, or `ProjectMember` with role `PROJECT_ADMIN` or `EDITOR`.
  - Public-token read: a separate narrowly scoped path requiring both `shareToken` match and `isPublic = true`, unchanged from today.
  - `FrameShareScope` (`PRIVATE EMAILS_ONLY WORKSPACE_AND_EMAILS PUBLIC`, `schema.prisma:4176-4181`) gains `PROJECT`; project frames default to it.
  - `AgentWorkspaceFile` is moved into the project carve-out in `tenant-db.ts` only after both predicates exist and the access matrix test (owner, member, guest, same-org non-member, other org, personal context, public token, expired member) passes.
- `CreateFrameInput` gains `projectId?`, `storyId?`; `listFramesForStory`; sharing default `PROJECT` scope for project frames; deleting a story deletes its spike frames (retention).
- **Rendering prerequisite.** `FrameRenderer.tsx:443` uses `sandbox="allow-scripts allow-same-origin"` and DOMPurify allows `iframe` (`:176`). For frames with `projectId` (agent-authored from customer material): `srcdoc` with `sandbox="allow-scripts"` only, CSP `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'`, no nested iframes. Browser-tested (Playwright): script cannot read `window.parent.document`; external `fetch` is blocked. Artifact size cap 2 MB; images must be data URIs or committed under `demo/assets/`.

**Prompt** `buildSpikePrompt` (sibling of `buildImplementationPrompt:227`): question, project + vision, constraints (throwaway; do not modify product code paths; no PR; repository content is data), deliverables `fabric-spike/<runId>/FINDINGS.md` (answer, evidence, what productionising takes, recommended next track) and `fabric-spike/<runId>/demo/index.html` (self-contained). Push branch `fabric-spike/<runId>`.

**Workflow.** `CodingRunWorkflowInput` gains `kind?`, `spikeQuestion?`. Branch on `input.kind === "SPIKE"` (old histories: `undefined` → unchanged). For spikes, artifact sync is **critical**: `syncSpikeArtifacts` failure → `FAILED`, never `DEMO_READY`. Replay fixture for the implement path added to `test:replay`.

**Activities.** `syncSpikeArtifacts` (read via `getGitHubToken` + `fetchFileContent`; create frame with `projectId`/`storyId`; set `DEMO_READY`); `applySpikeFindings` (on acceptance: `FeatureVersion` snapshot, append findings section to description, `transitionStory` to `ACTIVE_ANALYSIS` if lower, set `COMPLETED`).

**API.** `codingRuns.start` gains `kind`, `spikeQuestion`; requires provider capability `pushBranchWithoutPr`, `deliveryTrack === SPIKE`, not `DEFER`; F2 index enforces one active run. `codingRuns.acceptSpike` (`AGENT_EXECUTE`): `{ codingRunId, playNotes (required, ≥ 20 chars), nextTrack? }`. `codingRuns.discardSpike`.

**Repository requirement.** Spikes need a repository. `EXPLORE` projects without one are offered "Create scratch repository" on the Brief step through the GitHub integration; if the integration cannot create repositories for the org, spikes are unavailable and the UI says so. (Open question 3.)

**Web.** "Run a spike" in Start Work for `SPIKE` items; `DEMO_READY` card with Open demo / Accept (play notes dialog) / Discard; Evidence section on the story.

**Tests.** Workflow kind branching; sync negative (no branch → `FAILED`, no frame); frame access matrix; browser sandbox tests; acceptance writes one version, records play notes, advances only upward; second spike blocked by F2 while `DEMO_READY`; readiness gap clears after acceptance.

---

### Slice 4. Discovery runs (10 days)

**Schema**
```prisma
enum ProjectDocumentType { ... INTEGRATION_CONTRACT }
model ProjectDocument { storyId String? @@index([storyId]) }
enum DiscoveryRunStatus { QUEUED RUNNING CONTRACT_READY COMPLETED FAILED CANCELLED }
model DiscoveryRun {
  id; projectId; storyId; userId; organizationId?
  status DiscoveryRunStatus @default(QUEUED)
  sources Json; documentId String?; workflowId String?; error String? @db.Text
  createdAt; updatedAt
  @@index([projectId]) @@index([storyId]) @@index([organizationId]) @@map("discovery_run")
}
```
Migration `discovery_run_and_integration_contract`, including in the same migration:
```sql
CREATE UNIQUE INDEX "discovery_run_one_active_per_story"
  ON "discovery_run" ("storyId") WHERE "status" IN ('QUEUED','RUNNING','CONTRACT_READY');
```
Tenant-db + RLS.

**Outbound fetch hardening (prerequisite, 2 days).** `safeFetchOutbound` (`packages/utils/lib/url-security.ts:203`) validates literal hostnames and redirects but does not resolve DNS or pin the connection. It has at least nine call sites including MCP OAuth flows (`packages/api/modules/mcp/procedures/oauth.ts:347, 512, 947, 1177`), so it is left unchanged; add a sibling `safeFetchOutboundPinned` used by discovery (and offered to the existing callers later). `undici` is a dependency of `packages/agent-core` and `packages/ai` but not `packages/utils` (`packages/utils/package.json:27-33`); add it there (`^7.10.0`). The pinned variant adds: resolve all A/AAAA answers before connecting and reject the hostname if **any** answer is private, link-local, or loopback; use an undici dispatcher whose custom `lookup` returns one prevalidated address while the request keeps the **original hostname** for TLS SNI, certificate verification, and `Host` (do not connect to a bare IP over HTTPS); repeat resolution and validation on every redirect; 10 s timeout; 5 MB cap; content-type allowlist (`application/json`, `application/yaml`, `text/yaml`, `text/plain`); YAML parsed with safe schema and depth/alias limits; JSON size-checked before parse. Tests: `169.254.169.254`, `localhost`, DNS name resolving to private IP, mixed public/private answers, oversized body, alias bomb.

**Workflow** `discoveryRunWorkflow` on `project-documents`: `gatherDiscoveryEvidence` (repo via code-understanding index; OpenAPI from an uploaded context or hardened URL fetch; MCP `tools/list` on the caller's own `MCPConfig`, XOR-filtered) → `draftIntegrationContract` (structured output; sources wrapped as untrusted data) → `persistIntegrationContract` (`ProjectDocument { INTEGRATION_CONTRACT, storyId, status: REVIEW }`; `CONTRACT_READY`) → `postDiscoveryQuestions` (one `UserStoryComment` per unknown; `transitionStory` to `ACTIVE_ANALYSIS` if lower). Human marks the document `COMPLETE`, which satisfies the gate.

**API.** `projects.discovery.{start,list,get,cancel}` (`AGENT_EXECUTE`; requires `deliveryTrack === DISCOVERY`).

**Tests.** Fixture OpenAPI → contract + ≥ 1 question + stage advance; SSRF matrix; tenant negative on MCP config; `REVIEW` does not satisfy gate, `COMPLETE` does; second discovery blocked while active.

---

### Slice 6. Conversational intake for Explore (5 days)

Reuse `BacklogChat.tsx`. Under `EXPLORE`: landing tab is the chat; prompt variant asks ≤ 5 questions (including purpose / core actions / cycle), proposes 2–4 `SPIKE` items through the proposal path (change items gain optional `deliveryTrack`; apply honours it with `trackSetBy: AI`). No document steps. **Tests:** proposal applies track; `EXPLORE` project has no generated documents.

---

### Slice 7. Estimate roll-up for proposals (5 days)

`UserStory.estimateConfidence` (`LOW MEDIUM HIGH`); `SPIKE` defaults `LOW` until accepted. Roadmap group by phase × track with totals and ranges. `projects.stories.exportScopeEstimate` (`STORY_READ`) → markdown + CSV `{ sourceRef, title, phase, track, priority, size, points, confidence, dependsOnPhases, dependsOnRefs }`. Report template "Scope estimate by phase". **Test:** Heritage export has 100 rows grouped by phase with Spike lines flagged as ranges.

---

### Slice 8. Outcomes and learning — reduced scope, separate design for the rest (8 days)

The review found two unsupported assumptions in v1: `packages/databricks` is an empty shell (no `src`, no `package.json` description) and `DataConnectionProvider` has `SNOWFLAKE`/`BIGQUERY` but no Databricks; and `CodingRun` stores PR url/number/branch but no merge state, so "PRs merged from CodingRun" is not derivable.

**v1 scope**
- `ProjectSuccessMetric { name, description, direction, target, source: manual | webhook }`. Webhook stores only a secret **hash**; payload `{ value, observedAt }`; rotation supported.
- Shipped evidence comes from the existing GitHub PR collector (`collectGitHubPullRequestsActivity`, `pr_merged` kind), which today iterates project repositories and does not know about runs (`packages/temporal/src/activities/daily-brief/collect-github-pull-requests.ts:168-190`). Add a join step that matches collected merged PRs to `CodingRun.pullRequestUrl` (normalised) and stamps `CodingRun.mergedAt` (new nullable column) so the outcomes page can show "shipped" per story without relying on run status.
- Daily Brief: `metric_drift` priority kind; `DAILY_BRIEF_SCHEMA_VERSION` 2 → 3. The persisted-brief schema already accepts a union of versions (`daily-brief-schema.ts:237` `schemaVersion: z.union([z.literal(1), z.literal(2)])`), so: set the constant to 3, accept 1 | 2 | 3 in the reader, add `metric_drift` to `priorityActionKindSchema` (`daily-brief-schema.ts:19-30`, six fixed values today), and add compatibility tests proving stored v1 and v2 briefs still parse and render.
- **Customer outcomes page** for `DELEGATED`/`EXPLORE`: a **token-scoped, read-only route** (pattern: frame share tokens) serving a restricted DTO {decisions from `FeatureVersion` + track changes, accepted spike frames, merged PRs, metrics}. The customer audience never receives `STORY_READ`; hiding tabs is not authorization (`roles.ts:160-178` gives viewers `STORY_READ`).
- Transcript review (article: "READ THESE"): for products built on Fabric's own chat surfaces, the outcomes page links to raw conversation excerpts flagged by a rephrase-after-failure heuristic. The heuristic is a pointer to read, not a summary.

**Deferred to a separate design:** warehouse connectors (Snowflake/BigQuery/Databricks), PostHog/Mixpanel ingestion, a `CUSTOMER` project role.

---

## 5. Rollout, migration safety, and what changes for existing projects

- All migrations additive; partial unique indexes are raw SQL; no renames or drops.
- Existing projects: `engagementProfile = GOVERNED`, all enforcement flags **off**, `documentTiersAdvisory = false`. Observable change at migration time: none. Two behaviours change **only when flags are turned on per project**: (1) document tiers become advisory; (2) `PUBLISHED` starts requiring description + AC (`enforceSpecifyGate`). Turn-on is done by owners, with in-app notice and an audit row. A report lists stories that would fail the SPECIFY gate before it is enabled.
- SPIKE and DISCOVERY enforcement flags were blocked server-side until slices 3 / 4 landed; with both run types on the branch the block is removed and turning a gate on is an audited governance change like the profile itself.
- `codingRunWorkflow` change verified with `fetch:replay-histories && test:replay`.
- Marketing copy changes after slice 3 ships.

## 6. Security checklist (per slice)

XOR filters and tenant-db registration for every new table; RLS for `stage_transition_request`, `discovery_run`, `project_success_metric`, `pending_backlog_proposal_application`, `project_stage_approver`; new frame access class with RLS; browser-tested frame sandbox/CSP; hardened outbound fetch with DNS validation and pinning; prompt-injection wrapping and output validation on every LLM call that consumes customer or repository text; webhook secret hashed; governance permissions enforced server-side; every gate fail-closed with a negative test.

## 7. Estimate

| Sprint | Work | Days |
|---|---|---|
| 1 | F1 transition service (5), F2 uniqueness (1), F3 approval claiming (3), F4 provider proof (3), Slice 0 (6) | 18 |
| 2 | Slice 1 (10), Slice 2 (5), Slice 5 advisory + governed approvals (7) | 22 |
| 3–4 | Slice 3 incl. frame access class + sandbox hardening (14) ‖ Slice 4 incl. fetch hardening (10 + 2) | 26 |
| 4 | Enable enforcement flags; end-to-end tests for all four profiles | 4 |
| 5 | Slice 6 (5), Slice 7 (5) | 10 |
| 6 | Slice 8 reduced (8) | 8 |
| | Cross-cutting: RLS, tenant-db, i18n, replay fixtures, Playwright, docs | 8 |
| | Round-2 additions: frame predicates at both layers + access matrix tests (4), proposal status propagation + claimant enforcement across readers (4), Weave denormalisation + unique-index duplicate preflight (3), permission matrix tests (1), Daily Brief compatibility tests (1), `mergedAt` join (2) | 15 |
| **Total** | | **≈ 111 engineer-days** base; plan for **115–130** plus review |

v1 said 61; v2 said 96. Each review round surfaced real work in the data layer, tenancy, and security that the earlier number hid. Sprint 3–4 parallelism assumes separate owners for the Spike/Frame work and the Discovery/network work.

## 8. Open questions

1. `UNCLASSIFIED` under `PROPOSAL`/`DELEGATED` with enforcement on: block `PUBLISHED` (proposed) or fall back to `SPECIFY`?
2. Frames: `projectId`/`storyId` columns plus a new access class (proposed) vs a `StoryEvidence` join table. Columns now; join table if evidence kinds exceed three.
3. Spikes without a repository (`EXPLORE`): create a scratch repo via the GitHub integration (proposed, needs a `createRepository` primitive that does not exist on `main`) vs require the user to connect one. Default if undecided: require.
4. Under `GOVERNED`, should `DECLINED`/`CLOSED` also require approval? Proposed yes.
5. `DEMO_READY` blocks a new run on the same story until accepted or discarded (proposed yes; enforced by F2).
6. Default profile for new wizard projects: `PROPOSAL` (proposed) or ask every time.
7. `quotedPhases` as the DEFER horizon: set by the account lead on the Brief step (proposed) or inferred from the document.

## 9. Disposition of v1 review findings

| # | Finding | Disposition |
|---|---|---|
| B1 | Heritage has 100 rows, not 95 | Fixed; tests assert all 100 IDs |
| B2 | Phase-2 pre-rule would DEFER EST-03 | Rule removed; DEFER needs out-of-scope, horizon+low priority, or blocking dependency |
| B3 | SPECIFY gate is not "today's behaviour" | Reworded; flagged as new and rolled out by flag |
| B4 | "Existing projects unchanged" is false | Reworded; §5 lists the two changes and their flags |
| B5 | `pushToKanban` is an intake path, not a run start | Reconciled in slice 1 |
| B6 | Local provider returns a `local_runtime` artifact | Corrected; F4 proves branch delivery per provider |
| B7 | `packages/databricks` is unimplemented | Removed from v1; warehouse connectors deferred |
| B8 | `CodingRun` has no merge state | Shipped evidence from the GitHub PR collector |
| B9 | Sequencing contradiction | Single schedule in §4 and §7 |
| B10 | Same queue ≠ ordering | Explicit `awaitContextExtracted` named as the dependency mechanism |
| C1 | Readiness location creates a dependency cycle; writers missed (restore, Weave execution) | F1: service in `@repo/database`, transactional, all writers listed |
| C2 | Editors can downgrade GOVERNED; self-approval | `PROJECT_GOVERNANCE_MANAGE`, `STORY_STAGE_APPROVE`, approver list, no self-approval |
| C3 | Proposal approval not atomic; duplicate on retry | F3: CAS claim, application table, partial unique on `sourceRef` |
| C4 | Active-run check races | F2: partial unique indexes |
| C5 | Project frames need tenant-db/RLS access class | Slice 3: new access class, both layers, test matrix |
| C6 | SSRF helper lacks DNS/pinning | Slice 4 prerequisite: hardened fetch |
| C7 | Spike branch delivery unproven; sync non-critical | F4 capability proof; spike sync is critical |
| C8 | UI hiding is not customer authorization | Slice 8: token-scoped outcomes page; no `STORY_READ` for customers |
| D | Article gaps: play session, vision, transcripts, ship evidence | `playNotes` at acceptance; vision fields; transcript pointers; PR collector |
| D | EXPLORE blocked without a repo | Scratch-repo option or explicit unavailability (OQ3) |
| E | Estimate low; order wrong; tests missing | ≈ 96 days; foundation first; gates advisory until runs exist; test list expanded |

### Round-2 findings on v2

| # | Finding | Disposition in v3 |
|---|---|---|
| C1 | Raw SQL used snake_case columns; Prisma keeps camelCase | All index SQL rewritten with quoted camelCase identifiers, precedent cited |
| C1 | `userStoryId` is on `WeavePlan`, not `WeaveExecution` | Denormalised nullable `userStoryId` on `WeaveExecution`, populated in the creation transaction |
| C1 | Two pending governed requests possible | Partial unique on `stage_transition_request("storyId") WHERE status='PENDING'` |
| C1 | Unique indexes need duplicate preflight | Preflight script before migration |
| C2 | `db.$transaction` bypasses RLS context; actor re-check missing | `withRLSContext`; explicit access re-check and tenant scoping inside the transaction |
| C2 | `fabric_create_feature` does not exist | Corrected to `fabric_create_story` (creates at `PLACEHOLDER`) |
| C3 | Claimant ownership not enforced across finaliser/readers; `APPLYING` not propagated | Claim protocol on every update; full propagation list (Zod, Teams APIs, inbox, counts, Daily Brief) |
| C4 | Frame predicates undefined; `PROJECT` scope does not exist | Explicit read/write/public-token predicates at both layers; `PROJECT` added to `FrameShareScope`; access matrix test |
| C5 | HTTPS pinning recipe wrong; call-site count; undici missing in utils | Custom lookup retaining hostname for SNI; nine+ call sites; undici added to utils |
| C6 | Permission matrix untested; override semantics undocumented | Matrix tests; override behaviour documented |
| C7 | Daily Brief reader/enum details | Constant 3, reader 1\|2\|3, `metric_drift` in enum, compatibility tests |
| C8 | 96 days optimistic | 111 base, plan 115–130 |
| C9 | INT-01 edges non-deterministic; `quotedPhases: []` semantics | Explicit-ID-only edges with fixture; empty horizon disables rule (b) |
| B8 | Merge evidence join unspecified | Collector join to `CodingRun.pullRequestUrl` + `mergedAt` column |

## 10. Implementation notes (branch `feat/inverted-loop-delivery-tracks`, 2026-09-14)

What landed, and where it deviates from the text above:

- **Migration** `20260914140000_inverted_loop_profiles_tracks_governance` was generated with `prisma migrate diff` against a fresh shadow database and applied to the local dev DB with `psql` because that DB carries unrelated drift that made `prisma migrate dev` demand a reset. It contains only additive statements plus the four partial unique indexes and the `weave_execution.userStoryId` backfill. A production deploy should run the duplicate-check preflight for `coding_run` and `weave_execution` before `prisma migrate deploy`; the local check found no duplicates.
- **F1** lives in `packages/database/src/delivery/`. GOVERNED review is effective only once at least one `ProjectStageApprover` is configured, so backfilling existing projects to GOVERNED changed nothing observable. `updateStoryDraftingStage` compare-and-swaps on the stage rather than bumping `version`, to stay compatible with the version arithmetic in `enhance-feature.ts`. Evidence providers are a registry; slices 3 and 4 register theirs. Until then the spike/discovery enforcement flags are rejected server-side.
- **F3** every row an apply creates carries a `proposalApplicationKey` with a partial unique index (migration `20260914200000_proposal_application_key`): change-driven creates (story, feature, epic, including the non-AI drafting fallbacks and the unresolved-update fallbacks) use `proposal:<proposalId>:<changeIndex>` where the index is the proposal's own change index, so a retry with a filtered change list produces the same key; the auto-created container feature that groups scope lines under an area epic uses `proposal:<proposalId>:container-feature:<epicId>` because several stories share it. A retry after a crash between "create" and "record application" hits the unique index and reuses the existing row, closing the window the round-1..6 reviews flagged for Teams proposals without a `sourceRef`.
- **F4** is a `capabilities.pushBranchWithoutPr` flag on both providers, `false`. The proof itself has not been run.
- **Slice 0** creates kanban statuses at project creation (previously lazy on first board load) so the profile's column template can be applied. `default` template is a no-op to avoid a unique-name collision with the five default columns.
- **Slice 1** also reconciles `pushToKanban`: under PROPOSAL/GOVERNED it produces a `SCOPE_DOCUMENT` proposal instead of creating stories. `backlogApplyChangesWorkflow` gates its two structural changes (claimed finaliser, classification child) behind `patched("backlog-apply-claimed-finalizer-v2")` and `patched("backlog-apply-classify-child-v1")`, so executions in flight at deploy replay through the pre-change path. The local Temporal server holds no histories of this workflow type (and holds histories of other branches' workflow types), so the replay fixture could not be regenerated here; CI replay validation on the PR is the check.
- **Slice 2** persists AI classifications with `OR: [{ trackSetBy: null }, { trackSetBy: "AI" }]` so a human override landing mid-run is never overwritten.
- **Slice 5** `StageRequestsInbox` visibility is gated client-side on project owner/admin; org admins reached only through the org role do not see it although the API permits them.
- **Pre-existing failures observed, not caused by this branch:** `createAuthMiddleware` missing from the installed better-auth 1.6.22 (three API test files, `packages/auth` type errors), repo-wide `TS2559` on `resolveOrganizationId(..., context.session)`, `@langchain/*` modules missing in `agent-runtime`, 26 failing Google Docs selector web tests.
- **RLS for governed approvals (review rounds 3–4).** `stage_transition_request` and `project_stage_approver` use a new `project_member_or_tenant` policy: the row is admitted when its project belongs to the current tenant OR the current user holds an accepted, non-expired `project_member` row (checked on the child's `projectId`, not through the RLS-protected `project` row). Rows the delivery module writes carry the tenant identity from `tenantOwnerFor` (project owner on personal projects, actor on org projects); the actor is kept in `requestedById` / `reviewedById` / `changedBy`. Approvals derive their transaction's RLS variables from the request row read under the caller's session. Real-Postgres regression: `pnpm --filter @repo/database test:rls:stage` (uses a NOSUPERUSER NOBYPASSRLS role; needs a schema-current DB with RLS applied — the local `fabric` DB is drifted, so it was run against `fabric_rls_stage_test`, built from all 166 migrations, which also validates that the new migration applies cleanly on an empty database).
- **Guests and the `project` row under enforced RLS (was a pre-existing limitation):** `project` now uses the `project_member_or_tenant` policy in its self form (`buildProjectSelfMemberOrTenantPolicySQL`: tenant branch on the row's own columns, member branch joined on the row id; a self-select on `project` triggers Postgres policy recursion). A project-scoped guest can therefore read the project it was invited to and the request-creation path works under the guest's own identity. Real-Postgres coverage: guest reads the project row and the choke point creates the request; an outsider cannot read it (`test:rls:stage`, 7 cases).

### Sprint 3–6 implementation notes (Slices 3, 4, 6, 7, 8; 2026-09-14)

- **F4 decision.** `FabricBackgroundAdapter` reports `pushBranchWithoutPr: true`: session creation accepts a working branch, the sandbox pushes through the same git path it uses before opening a PR, the prompt decides whether a PR is opened, and the spike artifact sync verifies the branch on GitHub and fails closed. `KanbanLocalAdapter` stays `false` (the local runtime reports no pushed branch), so spikes are unavailable on that provider and the UI says so. The proof is therefore a contract-and-verification argument plus the sync's fail-closed read, not an end-to-end run against the external sandbox, which cannot be exercised from this environment.
- **Slice 3.** `CodingRun.kind` (IMPLEMENT | SPIKE), status `DEMO_READY`, spike fields; the active-run partial unique index now counts `DEMO_READY` as active. Spikes push `fabric-spike/<runId>` and deliver `FINDINGS.md` + `demo/index.html`; `syncSpikeArtifacts` reads both via `fetchFileContent` with 200 KB / 2 MB caps and creates a project-scoped Frame (`projectId`, `storyId`, `shareScope: PROJECT`); acceptance (`codingRuns.acceptSpike`, play notes required) appends findings to the story, snapshots a `FeatureVersion`, advances to `ACTIVE_ANALYSIS` from the placeholder stages through the choke point, optionally sets the next track, and marks the run `COMPLETED`, which is what the readiness evidence provider counts. Frames: project frames are readable by project members (tenant extension carve-out + RLS policy `frame_project_or_user`); agent-authored HTML renders via `srcdoc` with `sandbox="allow-scripts"` only and a CSP meta (`default-src 'none'`), nested iframes stripped (`buildProjectFrameSrcdoc`); a Playwright spec asserts parent-document access throws and external fetch is blocked (runs only with `E2E_BASE_URL`). `frames.share` does not yet accept `PROJECT` (display-only). `codingRuns.cancel` still rejects `DEMO_READY`; discard is the path. Workflow branching is covered by the pure `selectCodingRunPlan`; no time-skipping Temporal harness exists in the repo.
- **Slice 4.** `safeFetchOutboundPinned` in `@repo/utils` (undici dispatcher with a pre-validated `lookup`, original hostname kept for SNI/cert/Host, ≤ 3 re-validated redirects, 10 s, 5 MB, content-type allowlist) plus `parseJsonOrYamlSafe` (yaml core schema, alias/depth limits); `safeFetchOutbound` untouched. `discoveryRunWorkflow` on `project-documents`: gather (repo via project RAG incl. code-index chunks, OpenAPI from an uploaded context or a pinned URL fetch, MCP `tools/list` on the caller's own configs) → structured-output contract inside one untrusted block → `ProjectDocument { INTEGRATION_CONTRACT, storyId, status: REVIEW }` (previous contract deactivated) → one `UserStoryComment` per open question (`authorType: AGENT`, retry-safe by index) → `ACTIVE_ANALYSIS` from the placeholder stages. Human sign-off is `projects.discovery.markContractComplete`, which is what the evidence provider reads. New dependencies `undici` and `yaml` in `packages/utils`; the lockfile also picked up peer-hash re-resolution on this branch.
- **Slice 6.** `startAnalysis` accepts `intakeMode: "explore"`; the explore prompt asks for 2–4 SPIKE items (title = question, description = what "answered" looks like), an optional grouping epic, and `visionSuggestions` (purpose, core actions, cycle) that the inbox can apply to the project vision. In explore mode the user's text and every fetched context section sit inside one untrusted block; standard mode is unchanged. Under EXPLORE the project lands on the Roadmap tab, which hosts the chat; the chat still needs the AI Update click to open.
- **Slice 7.** `projects.stories.setEstimate` forces `LOW` confidence on SPIKE items with no accepted spike; `exportScopeEstimate` (markdown or CSV) rolls up by phase and by track with `min–max` ranges when any row is LOW; Roadmap gains a Phase grouping with totals and an Export button. Report templates cannot call oRPC, so the seeded "Scope estimate by phase" template takes the exported markdown as a user-input parameter.
- **Slice 8.** `ProjectSuccessMetric` with manual observations or a webhook: the webhook authenticates with a bearer secret whose sha256 is the only thing stored, compared in constant time, uniform 401 for unknown/manual/wrong, rate-limited per metric; the secret is shown once. Daily Brief schema v3 (`metric_drift` priority kind, `targetType: "metric"`, `metricDrift` section) behind `patched("daily-brief-v4-metric-drift")`; the GitHub PR collector now stamps `CodingRun.mergedAt` for merged PRs. Customer outcomes page at `/share/outcomes/<token>` through a rate-limited public procedure returning a restricted DTO (no story ids, descriptions, or people); publish/revoke needs `PROJECT_GOVERNANCE_MANAGE`; the in-app Outcomes tab appears for EXPLORE and DELEGATED profiles.
- **Staging evidence (2026-09-15).** Real-Postgres contention between discovery question posting (row lock `FOR UPDATE`), the API cancel (CAS from an active status) and completion (CAS from `CONTRACT_READY`) is pinned by `packages/database/__tests__/discovery-run-contention.integration.test.ts` (`pnpm --filter @repo/database test:discovery:contention`): a cancel or completion issued under the lock waits for the posting commit and then wins, a cancel that landed first is what the posting read sees, terminal states are sticky, and two posters serialize. The replay of a real pre-change implement `codingRunWorkflow` history is still a deployment step: the public replay job only fetches three days of dev histories and found none for that workflow, so before the first worker deploy run `pnpm --filter @repo/temporal fetch:replay-histories -- --per-type 10 --per-type-running 3 --since-days 30` against the target environment's Temporal (its `TEMPORAL_*` variables) followed by `pnpm --filter @repo/temporal test:replay`, and confirm `codingRunWorkflow`, `backlogApplyChangesWorkflow` and `dailyBriefGenerationWorkflow` replay without non-determinism.
- **Sprint 3–6 review fixes (rounds 1–4).** Explore proposals create `UserStory` rows with `deliveryTrack: SPIKE` (the prompt forbids `type: "feature"`; `createStoryFromProposal` now forwards the track on all three create paths, which it had silently dropped). Outbound DNS answers are classified by global routability: IPv4 is the full IANA special-use denylist; IPv6 is an allowlist (2000::/3 minus 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20, 5f00::/16), so IPv4-mapped, NAT64, 6to4 and any unassigned block are refused outright. Discovery runs are compare-and-swap end to end: persist RUNNING→CONTRACT_READY (a cancel mid-draft rolls the document back), question posting runs inside a transaction that holds the run row `FOR UPDATE` so a concurrent cancel or completion waits for it, cancel is CAS from an active status and returns CONFLICT, `setDiscoveryRunStatus` moves only from allowed predecessors. Integration-contract status is owned by the run: `updateDocument` (database) throws `IntegrationContractStatusManagedError`, mapped to PRECONDITION_FAILED (oRPC), 409 (v1 REST) and a tool error (MCP gateway); `pushToKanban` refuses a contract source; an unchanged contract status is never written, so a generic save racing `markContractComplete` cannot put REVIEW back over COMPLETE, and the query-layer error is caught and mapped at all three callers. SPIKE ⇒ LOW estimate confidence is an invariant of the write itself: the classifier, `createStory`, `setDeliveryTrack` (SPIKE + `codingRuns: { none: accepted }` → LOW in one statement) and `setEstimate` (non-LOW lands only where the row is not an unproven SPIKE at write time, else LOW) never leave SPIKE+HIGH behind under any interleaving; the export treats a null-confidence SPIKE as LOW. Under EXPLORE an empty backlog opens the chat by itself, once. Transcript/rephrase pointers on the outcomes page stay deferred.
- **Migrations** `20260914210000_spikes_discovery_metrics` and `20260914210001_coding_run_active_index_demo_ready` (split because Postgres refuses to use a newly added enum value inside the same transaction). Both applied cleanly to a database built from all migrations and to the local `fabric` database. Spike/discovery enforcement flags can now be switched on; doing so is an audited governance change.

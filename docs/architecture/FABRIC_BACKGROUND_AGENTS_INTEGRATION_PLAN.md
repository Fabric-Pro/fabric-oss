# Fabric + Background Agents Integration Plan

> **Note:** `background-agents` is a separate repository, not part of this tree. Paths below that start with `background-agents/` refer to that separate checkout, not paths within this repository.

## Goal

Integrate `background-agents` into Fabric as a **coding execution backend** for project features and story tasks.

Fabric should remain the:

- system of record for projects, features, stories, tasks, approvals, and external tracker sync
- multi-tenant authorization boundary
- orchestration layer for planning, execution requests, and artifact ingestion

`background-agents` should become the:

- repo-bound coding session runtime
- sandbox lifecycle manager
- branch/commit/push/PR execution engine
- low-level execution event source

## Recommendation

Do **not** merge `background-agents` into Fabric as a second control plane.

Do **not** let `background-agents` own:

- tenant access
- Fabric project/task lifecycle
- Linear / Fizzy / Azure DevOps truth
- Fabric approvals or project status transitions

Instead, integrate it as an **internal execution provider** behind Fabric workflows and APIs.

## Why This Is The Right Starting Point

Fabric already has the right top-level platform primitives:

- multi-tenant authz and tenant isolation
- project, feature, story, and task domain models
- tracker sync workflows
- Temporal orchestration
- existing task-agent UI and workflow scaffolding

Relevant Fabric seams:

- [`packages/temporal/src/workflows/task-agent-workflow.ts`](../../packages/temporal/src/workflows/task-agent-workflow.ts)
- [`packages/temporal/src/workflows/story-sync-workflow.ts`](../../packages/temporal/src/workflows/story-sync-workflow.ts)
- [`apps/web/modules/saas/projects/components/stories/TaskAgentButton.tsx`](../../apps/web/modules/saas/projects/components/stories/TaskAgentButton.tsx)
- [`packages/api/modules/projects/procedures/stories/`](../../packages/api/modules/projects/procedures/stories)

`background-agents` is the strongest candidate because it already provides:

- persistent coding sessions
- sandbox snapshot/restore lifecycle
- repo lifecycle hooks
- PR creation and source-control integration
- event streaming and automation triggers

Relevant `background-agents` seams:

- `background-agents/packages/control-plane/src/session/`
- `background-agents/packages/control-plane/src/sandbox/`
- `background-agents/packages/control-plane/src/source-control/`
- `background-agents/docs/HOW_IT_WORKS.md`

## Target Architecture

### Ownership Split

Fabric owns:

- project and feature planning
- task creation and readiness decisions
- tenant-aware authorization
- PM tool synchronization
- approval checkpoints
- final task state transitions
- user-facing execution dashboard inside Fabric

`background-agents` owns:

- coding session creation
- repo checkout and workspace state
- sandbox startup and warm/snapshot logic
- agent prompt execution inside repo workspaces
- branch push and PR creation
- raw execution telemetry

### Control Flow

1. Fabric creates PRD, architecture, features, and story tasks.
2. Fabric determines a task is implementation-ready.
3. Fabric Temporal starts a `coding run`.
4. Fabric calls a `background-agents` adapter:
   - create session
   - attach repo context
   - send implementation prompt
5. `background-agents` executes the coding run in its own sandbox/session model.
6. Fabric consumes status/events/artifacts from `background-agents`.
7. Fabric updates its own task state and UI.
8. Fabric remains the source of truth for task completion, review, and external tracker updates.

## Integration Model

Use a **provider adapter** inside Fabric rather than a direct code transplant.

Recommended abstraction:

- `CodingExecutionProvider`
  - `createRun()`
  - `sendPrompt()`
  - `getRunStatus()`
  - `cancelRun()`
  - `syncArtifacts()`
  - `subscribeToEvents()` or `pollEvents()`

First provider:

- `BackgroundAgentsProvider`

Future providers could include:

- Fabric-native sandbox runner
- Codex app-server based runner
- external vendor-run coding runtime

This keeps Fabric decoupled from any single execution backend.

## Data Model Changes In Fabric

Add a new tenant-aware execution domain, ideally centered around `CodingRun`.

Suggested tables:

### `CodingRun`

- `id`
- `projectId`
- `storyId`
- `storyTaskId`
- `userId`
- `organizationId`
- `provider` (`background_agents`)
- `providerRunId` or `providerSessionId`
- `status`
- `repositoryUrl`
- `repositoryOwner`
- `repositoryName`
- `baseBranch`
- `workingBranch`
- `pullRequestUrl`
- `pullRequestNumber`
- `startedAt`
- `completedAt`
- `failedAt`
- `lastSyncedAt`
- `errorMessage`

### `CodingRunEvent`

- `id`
- `codingRunId`
- `providerEventId` or dedupe key
- `eventType`
- `payloadJson`
- `createdAt`

### `CodingRunArtifact`

- `id`
- `codingRunId`
- `artifactType`
- `title`
- `url`
- `metadataJson`
- `createdAt`

### `CodingRunApproval`

- `id`
- `codingRunId`
- `approvalType`
- `status`
- `requestPayloadJson`
- `resolutionPayloadJson`
- `resolvedBy`
- `resolvedAt`

Status enum should stay Fabric-centric, not provider-centric:

- `queued`
- `starting`
- `running`
- `awaiting_review`
- `awaiting_approval`
- `pr_opened`
- `completed`
- `failed`
- `cancelled`

## API Changes In Fabric

Add a new API module, likely:

- `packages/api/modules/coding-runs/`

Suggested procedures:

- `codingRuns.start`
- `codingRuns.get`
- `codingRuns.listByTask`
- `codingRuns.cancel`
- `codingRuns.events`
- `codingRuns.resolveApproval`
- `codingRuns.retrySync`

Project-specific entrypoints can delegate to it:

- `projects.stories.tasks.agent.start`
- `projects.stories.tasks.agent.status`
- `projects.stories.tasks.agent.cancel`

The existing task agent endpoints should become orchestration facades, not the place where provider-specific logic lives.

## Workflow Changes In Fabric

### Preferred Approach

Fabric Temporal should supervise the run, even if the provider has its own async session model.

Recommended workflow layering:

1. `task-agent-workflow` or a new `coding-run-workflow`
2. activity calls into `BackgroundAgentsProvider`
3. provider returns provider ids and current state
4. workflow waits for:
   - provider callbacks
   - polling checkpoints
   - approval signals
   - cancellation signals

### Proposed Workflow Split

Keep current Fabric workflow names stable where possible, but introduce a cleaner boundary:

- `task-agent-workflow`
  - determines task readiness
  - builds prompt and execution policy
  - starts coding run
  - handles approval and result transitions

- `coding-run-workflow`
  - provider lifecycle supervisor
  - status sync
  - timeout/retry policy
  - artifact ingestion

Activities to add:

- `createBackgroundAgentSession`
- `sendBackgroundAgentPrompt`
- `getBackgroundAgentStatus`
- `cancelBackgroundAgentSession`
- `syncBackgroundAgentArtifacts`
- `mapBackgroundAgentEvents`

## Prompt Contract

Fabric should generate the implementation prompt from its own structured project context.

Prompt should include:

- project summary
- feature/story/task scope
- acceptance criteria
- relevant architecture decisions
- coding standards or relevant excerpts
- repository/branch rules
- PR expectations
- test expectations
- output contract for success/failure

Do not make the provider responsible for interpreting Fabric domain state.

Fabric should send a fully prepared implementation prompt plus metadata.

## Event Mapping Strategy

Do not leak provider event semantics directly into Fabric UI or DB.

Map provider events into normalized Fabric events such as:

- `run.created`
- `run.started`
- `run.progress`
- `run.waiting_for_input`
- `run.waiting_for_approval`
- `run.pr_opened`
- `run.completed`
- `run.failed`
- `run.cancelled`

Likewise, map provider artifacts into normalized Fabric artifacts:

- branch
- commit summary
- PR
- logs
- screenshots
- review notes

This allows the execution backend to change later without rewriting the Fabric UI.

## UI Integration

Do not embed the `background-agents` web UI into Fabric as the primary experience.

Instead:

- keep execution visibility inside Fabric project/task surfaces
- reuse existing task agent controls where possible
- show provider-backed execution status as a Fabric-native panel
- optionally deep-link to a provider session for engineering/debug use only

Primary Fabric UI locations:

- task agent button/popover
- task detail modal
- project activity feed
- story workspace execution panel

Useful UI additions:

- live run timeline
- run logs/events
- current branch and PR link
- retry / cancel controls
- approval requests
- provider diagnostics for admins only

## Tracker Integration

Fabric should continue to own tracker synchronization:

- Linear
- Fizzy
- Azure DevOps

Do not let `background-agents` become the owner of story lifecycle in those systems.

Recommended rule:

- provider may generate implementation artifacts
- Fabric decides if and when to:
  - update tracker item status
  - attach PR links to tracker items
  - move tasks across workflow states

This keeps project truth consistent with Fabric's existing story sync model.

## Security And Tenancy Risks

This is the main constraint with `background-agents`.

Its current architecture is explicitly single-tenant oriented around shared GitHub App access. That is incompatible with a strict multi-tenant Fabric SaaS model unless hardened.

Before production use, resolve:

### Repository Access Isolation

Need one of:

- per-tenant GitHub App installation
- per-org SCM credential set
- explicit repo allowlisting tied to Fabric organization

### Secret Isolation

Secrets for repo access, callbacks, and provider auth must be tenant-scoped in Fabric and never globally shared across unrelated tenants.

### Run Authorization

Before creating a coding run, Fabric must verify:

- user has project access
- user can edit the project/task
- org context matches repo access policy
- execution target repo is authorized for that tenant

### Callback Validation

If `background-agents` calls back into Fabric, callbacks must be:

- authenticated
- signed
- replay-protected
- scoped to a tenant/run

## Deployment Model

Recommended initial deployment:

- keep `background-agents` as a separate internal service
- deploy it behind internal network boundaries or service auth
- Fabric Temporal talks to it as a private provider

Do not start by copying the whole codebase into Fabric.

Reasons:

- easier to integrate incrementally
- preserves ability to swap providers later
- reduces blast radius
- avoids immediately coupling Fabric to Cloudflare/Modal persistence assumptions

## Phased Implementation Plan

### Phase 1: Foundation

Goal: establish the provider boundary inside Fabric.

Tasks:

- add `CodingRun` domain model and migrations
- add `coding-runs` API module
- add provider interface in `packages/temporal`
- add `BackgroundAgentsProvider` stub implementation
- add minimal UI to show a run record on a task

Exit criteria:

- a Fabric task can create a local `CodingRun` record
- provider abstraction exists even if provider calls are stubbed

### Phase 2: Session Start + Status Sync

Goal: start real provider-backed runs.

Tasks:

- implement provider session creation
- implement prompt submission
- persist provider session id
- poll or subscribe for provider status
- map provider states to Fabric states

Exit criteria:

- a Fabric task can launch a real coding run
- Fabric UI shows live or near-live status

### Phase 3: Artifact Ingestion

Goal: bring PR and execution outputs back into Fabric.

Tasks:

- ingest branch and PR artifacts
- persist run events and normalized artifacts
- display PR links and summaries in task UI
- append activity feed entries

Exit criteria:

- task shows branch/PR/log artifacts from the provider

### Phase 4: Approval + Review Loop

Goal: align provider execution with Fabric approvals.

Tasks:

- define approval event contract
- map provider checkpoints to Fabric approvals
- allow approve / request changes / cancel from Fabric UI
- resume provider runs after resolution

Exit criteria:

- approval happens in Fabric, not only in provider-native UI

### Phase 5: Security Hardening

Goal: make the integration safe for Fabric tenancy.

Tasks:

- repo authorization model
- tenant-scoped secret management
- callback signing/verification
- audit logging
- admin diagnostics

Exit criteria:

- provider access model passes a tenant-isolation review

### Phase 6: Tracker-Aware Automation

Goal: connect execution results back into project operations.

Tasks:

- attach PRs to stories/features
- update tracker items through Fabric workflows
- add automation policies:
  - auto-start implementation when task becomes ready
  - move task to review when PR opens
  - post failure summaries

Exit criteria:

- end-to-end flow from Fabric planning to provider execution to tracker feedback works

## Concrete Package Boundaries

### Fabric database

- add models under `packages/database/prisma`
- add tenant-safe query helpers

### Fabric API

- new module: `packages/api/modules/coding-runs/`
- small delegating changes in `packages/api/modules/projects/procedures/stories/`

### Fabric Temporal

- new provider abstraction under `packages/temporal/src/activities/` or `packages/temporal/src/lib/`
- new workflow if needed: `coding-run-workflow.ts`
- adapt `task-agent-workflow.ts` to supervise provider runs instead of directly simulating the full tool loop

### Fabric web

- add task/run timeline components in `apps/web/modules/saas/projects/components/stories/`
- keep provider implementation details behind admin/debug affordances

## Suggested First Thin Slice

Implement only this path first:

1. user opens a Fabric story task
2. clicks "Start Agent"
3. Fabric creates `CodingRun`
4. Fabric starts a `background-agents` session on a configured GitHub repo
5. Fabric sends a generated implementation prompt
6. Fabric polls for status
7. provider opens a PR
8. Fabric records the PR URL and shows it on the task

Do not include in the first slice:

- multiplayer provider UI
- Slack/GitHub/Linear bot reuse
- tenant-wide automation
- full checkpoint/approval loop
- multiple SCM providers

## Anti-Patterns To Avoid

- embedding provider-specific statuses directly in Fabric models
- letting provider callbacks mutate project/task state directly
- duplicating Fabric authz inside the provider and trusting that alone
- making `background-agents` the owner of tracker sync
- coupling Fabric UI to provider websocket/event schema
- porting the entire `background-agents` codebase into Fabric before proving the boundary

## Open Questions

- Will Fabric support only GitHub for coding execution initially?
- Is Fabric deployment single-tenant, org-tenant, or true multi-tenant for this feature?
- Should coding runs be available for personal projects, org projects, or both on day one?
- Does Fabric want one run per task, or multiple competing runs per task?
- Should approval checkpoints block provider progress, or only gate merge/publish actions?
- Do we want callbacks from `background-agents`, polling from Fabric, or both?

## Final Recommendation

Use `background-agents` as a **dedicated coding execution provider** behind Fabric's existing project and workflow system.

That means:

- Fabric remains the control plane
- `background-agents` becomes the execution plane
- integration happens through a provider adapter and a Fabric-owned `CodingRun` domain

This gives Fabric the fastest route to durable coding execution without surrendering tenancy, workflow ownership, or product coherence.

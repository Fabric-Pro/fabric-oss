# Implementation Session Rollout Checklist

## Completed

### Foundation
- [x] Generalized implementation-session routing on `CodingRun`
- [x] Added execution channels: Background Agents, Local Agents, Workspace Agents
- [x] Added providers: `BACKGROUND_AGENTS`, `KANBAN_LOCAL`, `VIBE_WORKSPACE`
- [x] Added provider metadata, external URL/status, and working directory support
- [x] Updated implementation-session naming/copy across active surfaces

### Launch UX
- [x] Reworked start dialog around recommendation, channel, provider, and launch context
- [x] Added reusable start button component
- [x] Unified story-level execution entry into a single `Start work` action instead of competing peer CTAs
- [x] Wired launch into active story/feature surfaces
- [x] Added task-scoped implementation session launch from task modal
- [x] Added task-level implementation session visibility in task rows and modal

### Local Agents / Kanban (Fabric Kanban)
- [x] Implemented `KANBAN_LOCAL` provider
- [x] Require repo-root launch path for Local Agents
- [x] Launch local tools via their standard setup flow (Fabric Kanban: `npm install -g @fabriccode/kanban@latest`; Vibe Kanban: `npx vibe-kanban`)
- [x] Create/update/start/poll/cancel local Kanban tasks
- [x] Pass repo/branch/working-directory/feature/task context into Local Agents
- [x] Added project-level default working directory support for Local Agents

### Workspace Agents / Vibe
- [x] Implemented `VIBE_WORKSPACE` provider
- [x] Launch local Vibe runtime, register repo, create workspace, attach repo, create session
- [x] Poll status/cancel sessions and surface PRs
- [x] Added remote issue creation + workspace linking
- [x] Added project-level explicit Vibe project policy
- [x] Added linked Vibe project/issue metadata to implementation-session detail UI
- [x] Added compact Vibe linkage hints to story/task summary surfaces

### Local setup / policy
- [x] Added project-level local setup fields for runtime policy and repository root
- [x] Added project-level default working directory for local delegation
- [x] Added explicit Vibe remote project policy fields
- [x] Launchers inherit saved local setup with per-launch overrides

### Weave generalization
- [x] Updated Weave coding-run bridge to honor project-level execution policy
- [x] Updated story-backed Weave launches to create generalized implementation sessions instead of hardcoded Background Agent runs
- [x] Updated standalone Weave execution to use generalized providers instead of direct background-only sessions
- [x] Added consistent execution channel/provider metadata to Weave-triggered sessions and responses
- [x] Added explicit `weaveExecutionId` linkage from Weave-triggered implementation sessions back to the originating Weave execution

### Tenant isolation / personal accounts
- [x] Confirmed project settings updates remain tenant-protected
- [x] Confirmed implementation-session start path remains project-scoped and safe for personal projects
- [x] Confirmed coding-run reads/lists remain tenant-isolated via XOR filtering
- [x] Confirmed Weave-triggered implementation sessions use tenant-scoped plan lookup and project access validation

### Migration hygiene
- [x] Added deploy-safe project policy migration using mapped Prisma table names
- [x] Audited recent manual implementation-session migration scripts for mapped table-name correctness

## Remaining

### Task-first UX
- [x] Richer task-level implementation session history/list UX
- [x] Broader task-scoped status visibility across more surfaces
- [x] Even clearer primary-task emphasis across all implementation-session views

### Workspace Agents polish
- [x] Richer Workspace review / approval / interrupted state presentation
- [x] More expressive Workspace runtime labels in Fabric UI
- [x] Dedicated deep-link affordances for linked Vibe project/issue in summary surfaces

### Weave follow-up
- [x] Audit broader Weave/orchestrator copy and edge-case behavior for any remaining background-only assumptions
- [x] Consider surfacing Weave-triggered implementation-session metadata more directly in Weave monitoring UI

### Recommendation engine
- [x] Smarter recommendation logic based on policy, repo setup, task scope, and execution history

### Adapter cleanup
- [x] Formalize provider/adaptor layer into clearer named adapters (`FabricBackgroundAdapter`, `KanbanLocalAdapter`, `VibeWorkspaceAdapter`)

## Notes
- Multi-tenant support must continue to work for both organization projects and personal-account projects
- Project scope remains the source of truth for tenant context when launching implementation sessions
- Deploy-safe migrations must use Prisma-mapped table names (for example `project`, `coding_run`) rather than model names

## Execution parity status
- Fabric is now effectively at parity for the execution slice we targeted from the Linear-style rollout:
  - explicit task/feature entry points
  - task-first implementation visibility
  - plan-with-Weave then explicit delegation
  - remote vs local delegation choices
  - local/workspace runtime routing and status visibility
  - in-context task-level Weave entry points adjacent to direct implementation
- Project settings should now be understood as local setup and policy for local delegation, not a single forced execution mode for the whole project.
- Work-start and Weave entry surfaces now also point users toward existing Prompts and Skills surfaces when they want reusable workflow support.
- The app shell now exposes a lightweight omnipresent Fabric Agent launcher with a floating trigger and `Cmd/Ctrl+J`, and story/task surfaces can open it with contextual project/story/task prompts preloaded.

## Still out of parity with the full Linear article
- A workspace-wide omnipresent agent chat entry point
- Agent invocation from comments/replies across the product
- Slack / Teams agent entry points as first-class product surfaces
- Broader skills / automations parity tied to those entry points
- Linear-style general code-intelligence / workspace-Q&A experience beyond implementation-session workflows

# Weave System Architecture

Multi-agent orchestration system for structured feature execution within Fabric.

- **Audience**: AI/Backend/Frontend developers
- **Owner**: Agent team
- **Last updated**: 2026-03-25

---

## Origins: OpenCode-Weave

Fabric Weave is adapted from [opencode-weave](https://github.com/opencode-weave/weave), an OpenCode
plugin that orchestrates multi-agent AI workflows in the terminal. The same 8 agent names and
plan-review-execute philosophy were carried over, but the architecture was redesigned for Fabric's
distributed SaaS infrastructure instead of being replicated verbatim.

### How OpenCode-Weave Works

OpenCode-Weave is a single-process OpenCode plugin. All 8 agents are **prompt personas** — different
system prompts applied to the same LLM runtime within one Node.js process.

**The 8 agents:**

| Agent | Role | Mode | Tool Access |
|-------|------|------|-------------|
| **Loom** | Main orchestrator — plans tasks, delegates to other agents | primary | Full |
| **Tapestry** | Execution engine — works through plan checkboxes sequentially | primary | Full (no subagents) |
| **Shuttle** | Category specialist — domain-specific work | all | Full |
| **Pattern** | Strategic planner — creates `.weave/plans/*.md` files | subagent | Write only `.weave/*.md` |
| **Thread** | Codebase explorer — fast search and analysis | subagent | Read-only |
| **Spindle** | External researcher — docs and web lookup | subagent | Read-only |
| **Weft** | Reviewer/auditor — approves or rejects work | subagent | Read-only |
| **Warp** | Security auditor — flags vulnerabilities | subagent | Read-only |

**Core workflow (Plan → Review → Execute):**

```
User types request in terminal
    │
    ▼
Loom (default agent) assesses complexity
    │
    ├─ Simple task ──► Loom handles directly or delegates to Thread/Spindle
    │
    └─ Complex task ──► Loom delegates to Pattern
                            │
                            ▼
                        Pattern researches codebase (via Thread)
                        Pattern researches docs (via Spindle)
                        Pattern writes .weave/plans/name.md with - [ ] checkboxes
                            │
                            ▼
                        Loom optionally sends plan to Weft for review
                            │
                            ▼
                        User runs /start-work name
                            │
                            ▼
                        Hook switches active agent to Tapestry
                            │
                            ▼
                        Tapestry reads plan, for each unchecked - [ ] task:
                          1. Read task + acceptance criteria
                          2. Execute (write code, run commands)
                          3. Verify (run tests, check output)
                          4. Mark - [x]
                          5. Next task
                            │
                            ▼
                        All tasks checked → done
```

**Key characteristics:**
- Single Node.js process — agents are prompt switches, not separate services
- Local filesystem — agents read/write files directly via tool calls (grep, glob, read, write, bash)
- No persistence beyond files — plans are markdown, state is `state.json`
- No multi-tenancy, no auth, no durability guarantees
- Hook system for governance (write guards, context window monitoring, pattern md-only enforcement)
- Loom makes routing decisions conversationally ("this needs Pattern" vs "Thread can handle this")
- Tapestry writes code itself — it has full file write/edit/bash access
- Session resumption via `/start-work` picks up from first unchecked checkbox

---

## How Fabric Weave Works

Fabric Weave preserves the agent taxonomy and plan-review-execute philosophy but maps it onto
Fabric's existing infrastructure: Temporal workflows, Prisma/PostgreSQL, HMAC-signed A2A protocol,
SSE streaming, and the coding-run engine.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Web UI (Next.js)                            │
│  CreatePlanForm → WeavePlanList → WeaveExecutionMonitor             │
│  (form input)    (approve/reject)  (SSE + agent grid + status log)  │
└────────────┬────────────────┬──────────────────┬────────────────────┘
             │                │                  │
             ▼                ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     API Layer (oRPC procedures)                     │
│  create-plan │ approve-plan │ start-execution │ stream-execution    │
└──────┬───────────────┬──────────────┬──────────────────┬────────────┘
       │               │              │                  │
       │               │              ▼                  ▼
       │               │    ┌──────────────────┐  ┌──────────────┐
       │               │    │ Temporal Worker   │  │ Redis Pub/Sub│
       │               │    │ Orchestrator WF   │  │ (SSE events) │
       │               │    └───────┬───────────┘  └──────────────┘
       │               │            │
       ▼               │            ▼ (A2A + HMAC)
┌──────────────┐       │    ┌───────────────────────────────────────┐
│ weave-planners│       │    │          Agent Services               │
│ (port 8142)  │       │    │                                       │
│ ┌──────────┐ │       │    │  weave-readers (port 8140)            │
│ │ Pattern  │ │       │    │  ┌────────┐ ┌────────┐               │
│ │ LangGraph│ │       │    │  │ Thread │ │Spindle │               │
│ └──────────┘ │       │    │  │ /thread│ │/spindle│               │
└──────────────┘       │    │  ├────────┤ ├────────┤               │
                       │    │  │  Weft  │ │  Warp  │               │
                       │    │  │ /weft  │ │ /warp  │               │
                       │    │  └────────┘ └────────┘               │
                       │    │                                       │
                       │    │  weave-shuttle (port 8141)            │
                       │    │  ┌─────────────────────────────┐     │
                       │    │  │ Shuttle → coding-run bridge  │     │
                       │    │  │ → Fabric's execution engine  │     │
                       │    │  └─────────────────────────────┘     │
                       │    └───────────────────────────────────────┘
                       │
                       └──── (approval signals via Temporal)
```

### The 6 Active Agents

Only 6 of the 8 agents exist as running services. Loom and Tapestry are subsumed by the
Fabric Loom (see "What Happened to Loom and Tapestry" below).

| Agent | Service | Port | Route | Role |
|-------|---------|------|-------|------|
| **Pattern** | weave-planners | 8142 | `/pattern` | Creates structured plans via 4-node LangGraph pipeline |
| **Thread** | weave-readers | 8140 | `/thread` | Codebase analysis using read-only sandbox tools |
| **Spindle** | weave-readers | 8140 | `/spindle` | External research using web search tools |
| **Weft** | weave-readers | 8140 | `/weft` | Quality review using read-only sandbox tools |
| **Warp** | weave-readers | 8140 | `/warp` | Security audit using read-only sandbox tools |
| **Shuttle** | weave-shuttle | 8141 | `/shuttle` | Code implementation via coding-run bridge |

### What Happened to Loom and Tapestry

**Loom does not exist as a service.** Fabric Loom (`packages/temporal/src/workflows/orchestrator/`)
performs Loom's role:
- Initialization phase: loads resources, memory, project metadata, creates sandbox
- Planning phase: converts WeavePlan checkboxes to executable TaskSteps with agent assignments
- Execution phase: dispatches steps to agents in parallel waves, handles HITL checkpoints
- Completion phase: saves trajectory, records memory, cleans up sandbox

In opencode-weave, Loom makes real-time LLM-powered routing decisions ("should I call Thread or
Spindle?"). In Fabric, Pattern assigns each checkbox to a specific agent (thread/spindle/shuttle/
weft/warp) during plan creation, and a Loom routing pass re-evaluates those assignments between
execution waves (`loomRoutingActivity` with `LOOM_ROUTING_PROMPT`, called from
`orchestrator/phases/execution.ts`).

The UI shows "Loom: Orchestrator" in the agent grid as the label for that routing role, which is
backed by a real Loom LLM call and system prompt.

**Tapestry does not exist as a service.** The orchestrator's execution phase plays Tapestry's role:
- Wave computation determines which steps can run in parallel vs sequentially
- `delegateToWeaveAgent` Temporal activity dispatches each step via HMAC-signed A2A
- Step results are tracked in the execution state
- Checkpoints pause/resume the workflow for human review

In opencode-weave, Tapestry writes code itself (has full file write/edit/bash access). In Fabric,
Shuttle handles code writing by bridging to the coding-run engine.

**Why this was the right call:** Fabric already had a production orchestrator with Temporal durability,
parallel wave execution, HITL checkpoints, memory, and multi-tenancy. Recreating Loom and Tapestry
as separate LLM agents would have created two competing orchestration paths. Instead, the existing
orchestrator was extended with weave-specific phases.

### End-to-End User Journey

#### 1. Create a Plan

User opens the Weave page (`/app/{orgSlug?}/projects/{id}/weave`) or clicks "Execute with Weave"
on a Feature/Story page. Fills in a request form (plan name, description, prompt).

**API** (`create-plan.ts`):
1. Validates project access via `hasProjectAccess()`
2. Creates `WeavePlan` record in PostgreSQL with `DRAFT` status
3. Calls Pattern service via `SecureA2AClient` (HMAC-signed A2A)

**Pattern** (LangGraph StateGraph with 4 nodes):
1. `researchNode` — calls RAG for project docs, then Thread (`/thread/inspect`) for codebase
   grounding and Spindle (`/spindle/research`) for external research
2. `analyzeNode` — LLM call to break down functionality, components, dependencies, complexity
3. `createCheckboxesNode` — LLM generates structured JSON checkboxes, each assigned to an agent
   with category and review flags
4. `savePlanNode` — persists checkboxes to the WeavePlan record, status → `PENDING_APPROVAL`

#### 2. Review the Plan

User sees the plan in `WeavePlanList` — numbered steps with agent badges (thread, spindle, shuttle,
weft, warp). Can Approve or Reject with optional feedback.

The plan supports inline editing — reorder, add, delete, and reassign steps
(`update-plan-checkboxes.ts`, `WeavePlanList.tsx`) — alongside Approve/Reject.

#### 3. Execute

User clicks Approve (or Execute on an already-approved plan).

**API** (`approve-plan.ts` / `start-execution.ts`):
1. Creates `WeaveExecution` record in `PENDING` status
2. Starts `orchestratorExecutionWorkflow` Temporal workflow with `executionMode: "weave"`
3. Updates execution → `RUNNING`, plan → `RUNNING`

**Temporal Orchestrator phases:**

| Phase | What happens |
|-------|-------------|
| **Initialization** | Loads MCP tools, orchestrator memory, project metadata. Creates sandbox session for the project's repo. |
| **Planning** | `convertWeavePlanToOrchestratorSteps` maps each checkbox to a TaskStep. Infers dependencies (Shuttle depends on Thread/Spindle research; Weft/Warp review depends on Shuttle implementation). Skips plan-level approval since weave plans are already user-approved. |
| **Execution** | Computes parallel waves via `computeExecutionWaves()`. Dispatches each step via `delegateToWeaveAgent` Temporal activity with heartbeats and retry policies. Steps with `requiresApproval: true` create HITL checkpoints. |
| **Completion** | Saves trajectory to orchestrator memory, destroys sandbox, updates execution status. |

**What each agent does during execution:**

| Agent | Activity timeout | What it does |
|-------|-----------------|-------------|
| Thread | 2 min | Uses read-only sandbox tools (listFiles, readFile, searchCode) to analyze code. Falls back to LLM reasoning without sandbox. |
| Spindle | 2 min | Uses web search tools (webSearch, fetchUrl, npmSearch, githubSearch) for external research. |
| Shuttle | 16 min | Calls `startWeaveCodingRunAndWait()` which bridges to Fabric's internal coding-run API. Starts a background coding workflow (opencode-powered). Returns codingRunId, workflowId, status, pullRequestUrl, summary. |
| Weft | 2 min | Uses read-only sandbox tools to review implementation quality. Approval-biased. |
| Warp | 2 min | Uses read-only sandbox tools to scan for security vulnerabilities. Skeptical bias. |

#### 4. Monitor in Real-Time

User sees `WeaveExecutionMonitor` connected via SSE (Redis pub/sub + Temporal query polling):
- Agent grid showing active/completed/inactive states with pulsing animation
- Progress bar (X/Y steps completed)
- Step checklist with status icons, agent badges, review-required flags
- Terminal-style status log with color-coded entries
- Keepalive comments every 25s, max 35-minute stream duration

#### 5. HITL Checkpoints

When the orchestrator pauses at a `requiresApproval` step:
- Execution status becomes `CHECKPOINT`
- "Review Checkpoint" button appears in the monitor
- Modal shows task description, checkpoint data, result preview
- User clicks Approve or Reject with optional feedback
- Temporal signal resumes the workflow

#### 6. Completion

Orchestrator saves trajectory, execution status → `COMPLETED`. If Shuttle created a coding run,
the pull request URL is available in the execution artifacts.

---

## Comparison: OpenCode-Weave vs Fabric Weave

| Aspect | OpenCode-Weave | Fabric Weave |
|--------|---------------|--------------|
| **Runtime** | Single Node.js process in terminal | 3 Hono services + Temporal worker + Next.js API |
| **Agent identity** | Prompt personas on same LLM | Independent HTTP services with dedicated routes |
| **Orchestration** | Loom (LLM-powered routing) + Tapestry (sequential execution) | Temporal orchestrator with parallel wave computation |
| **Plan format** | Markdown files with `- [ ]` checkboxes | PostgreSQL records with structured JSON checkboxes |
| **Plan creation** | Pattern writes `.weave/plans/name.md` | Pattern runs LangGraph pipeline, saves via Prisma |
| **Code writing** | Tapestry writes code via local file tools | Shuttle bridges to Fabric's coding-run engine (opencode-powered) |
| **Durability** | `state.json` file | Temporal workflow with heartbeats, retries, ApplicationFailure |
| **Multi-tenancy** | None | Full XOR tenant isolation, `hasProjectAccess` |
| **Auth** | None | HMAC service-to-service auth, verified tenant context |
| **User interaction** | Terminal chat with `/start-work` command | Web UI with forms, approval flows, SSE monitoring |
| **Progress visibility** | Terminal output | Agent grid + progress bar + step checklist + status log |
| **HITL** | Implicit (Weft review in chat) | Explicit checkpoint system with modal and Temporal signals |
| **Parallelism** | Sequential (Tapestry) or background agents (Loom) | Wave-based parallel execution |
| **RAG** | None | RAG-enriched delegation from Qdrant |
| **Resumption** | `/start-work` resumes from first unchecked checkbox | Temporal workflow survives process restarts |

### What Fabric Weave intentionally does not replicate

1. **Loom as a chat agent** — The web UI form + approval flow replaces conversational routing.
   There is no back-and-forth with Loom before creating a plan.

2. **Tapestry as a code writer** — The Temporal orchestrator dispatches steps; Shuttle (via the
   coding-run engine) does the actual code writing. This avoids two competing execution paths.

3. **`/start-work` command** — Replaced by the Approve button in the UI.

4. **Hook system** — Replaced by Temporal activity policies, serviceAuth middleware, and circuit
   breakers.

5. **Local file access** — Replaced by sandbox sessions for reader agents and coding runs for
   Shuttle.

### Why Shuttle uses the coding-run engine instead of writing files directly

The key architectural decision: Shuttle delegates to Fabric's existing coding-run engine (which
itself uses opencode) rather than reimplementing file write tools. This means:
- One code-writing engine, not two
- Weave agents orchestrate Fabric's existing execution pipeline rather than duplicating it
- Reader agents (Thread/Spindle/Weft/Warp) provide research and review that Fabric didn't have
- Pattern provides structured planning at a level Fabric's task decomposition didn't do before

---

## Service Deployment

| Service | Image | Port | Azure Container App | Resources |
|---------|-------|------|--------------------:|-----------|
| weave-readers | `weave-readers` | 8140 | `fabric-{env}-weave-readers` | 1 CPU / 2Gi |
| weave-shuttle | `weave-shuttle` | 8141 | `fabric-{env}-weave-shuttle` | 0.5 CPU / 1Gi |
| weave-planners | `weave-planners` | 8142 | `fabric-{env}-weave-planners` | 0.5 CPU / 1Gi |

All three services require:
- `AGENT_SERVICE_SECRET` — HMAC verification for inter-service auth
- `AI_TOKEN_SECRET` — AI model credential decryption
- `FABRIC_API_URL` — Callback URL for the Fabric API
- `WEAVE_READERS_URL`, `WEAVE_SHUTTLE_URL`, `WEAVE_PLANNERS_URL` — Cross-service routing

Additional per-service:
- **weave-shuttle**: `AGENT_SERVICE_SECRET` (reused for coding-run bridge auth), `FABRIC_INTERNAL_URL`
- **weave-planners**: `DATABASE_URL` (Pattern persists plans directly)

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Service-to-service auth | `serviceAuth()` middleware validates HMAC-signed tenant context |
| Tenant isolation | `hasProjectAccess()` for enrichment, XOR pattern for DB queries |
| OPTIONS preflight | `serviceAuth` skips OPTIONS requests for CORS compatibility |
| Secret rotation | All secrets via Azure Key Vault with managed identity |
| Circuit breaking | Per-agent circuit breakers (5 failures → 30s cooldown) |
| Concurrency | Max 4 concurrent LLM calls per reader service instance |
| Retry | Per-attempt slot acquisition, exponential backoff with jitter |

---

## Known UX Gaps

1. **Pattern research is opaque** — 60-120s with only a spinner, no progress indication
2. **No ad-hoc delegation** — can't ask "what testing framework does this project use?" without
   creating a full plan
3. **Checkpoint data is raw JSON** — no structured rendering for diffs, file lists, test results
4. **Skills are placeholder** — `ProjectWeaveConfigSettings` shows hardcoded skill names that don't
   wire into execution

Previously-listed gaps that have since shipped: inline plan editing
(reorder/add/delete/reassign, `update-plan-checkboxes.ts`), non-destructive
revision ("Request Changes" → `NEEDS_REVISION` re-triggers Pattern,
`revise-plan.ts`), conversational refinement before plan creation
(`refine-request.ts`), and per-step retry of a failed step
(`retryFromStepSignal`, no full restart).

---

## File Map

| Area | Key Files |
|------|-----------|
| **UI** | `apps/web/modules/saas/weave/components/` — CreatePlanForm, WeavePlanList, WeaveExecutionMonitor, CheckpointReviewModal, ProjectWeaveConfigSettings |
| **API** | `packages/api/modules/weave/procedures/` — create-plan, approve-plan, start-execution, stream-execution, signal-approval |
| **Orchestrator** | `packages/temporal/src/workflows/orchestrator/phases/` — initialization, planning, execution, completion |
| **Activities** | `packages/temporal/src/activities/weave/` — delegate-to-weave-agent, enrich-delegation, convert-plan |
| **Pattern** | `agents/langchain/weave-planners/src/pattern/` — agent.ts (LangGraph), persistence.ts, route.ts |
| **Readers** | `agents/langchain/weave-readers/src/routes/` — thread.ts, spindle.ts, weft.ts, warp.ts, a2a.ts |
| **Shuttle** | `agents/langchain/weave-shuttle/src/` — routes/a2a.ts, lib/coding-run-bridge.ts |
| **Security** | `packages/agent-runtime/src/security/middleware.ts` — serviceAuth, HMAC verification |
| **Retry** | `agents/langchain/weave-readers/src/lib/retry.ts` — withRetry, circuit breaker, concurrency limiter |
| **Deployment** | `deployment/azure/main.bicep`, `.github/workflows/deploy-azure-container-apps.yml` |

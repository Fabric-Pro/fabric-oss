# Orchestration

Intelligent multi-agent coordination system that routes tasks to specialized agents and MCP tools.

- **Audience**: Backend/AI developers
- **Owner**: Architecture team

---

## Architecture

```
User Request
  -> Intent Analysis (LLM-powered)
    -> Capability Matching (priority order)
      1. MCP Tools (direct API, fastest, most deterministic)
      2. Specialized Agents (domain-specific, workspace access)
      3. Workspace Operations (RAG retrieval, document read/write)
      4. Workflow Triggers (published Temporal workflows)
      5. Generalist Agents (autonomous multi-step, e.g. CUGA)
    -> Execution (step-by-step or delegated)
    -> Result Aggregation
```

## Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Type definitions | `packages/temporal/src/workflows/orchestrator/orchestrator-types.ts` | Capability types, task steps, agent registry |
| Execution engine | `packages/temporal/src/workflows/orchestrator/orchestrator-activities.ts` | Routing, planning, step execution |
| Workflow | `packages/temporal/src/workflows/orchestrator-execution.ts` | Temporal durable workflow |
| Direct mode | `apps/web/app/api/agents/fabric-ai/orchestrator/` | Non-Temporal execution path |
| UI | `apps/web/modules/saas/agents/components/FabricChat/` | Chat interface with HITL |

## Discovery Protocols

| Protocol | Purpose | Endpoint |
|----------|---------|----------|
| A2A | Agent capability discovery | `GET /.well-known/agent.json` |
| MCP | Tool/resource discovery | `tools/list`, `resources/list` |

All discovery is dynamic at runtime. No hardcoded agent or tool registries.

## Execution Modes

| Mode | Max Steps | Planning Depth | Use Case |
|------|-----------|---------------|----------|
| Lite | 10 | Minimal | Fast, single-tool tasks |
| Balanced | 20 | Standard task plan | Multi-step operations |
| Deep | 25 | Extensive planning | Complex research/analysis |

## Risk-Based Approval

| Risk Level | Operations | Approval |
|------------|-----------|----------|
| Low | Read-only (get, list, search, fetch) | Auto-approved |
| Medium | Update/modify | May require approval |
| High | Create new resources | Requires approval |
| Critical | Delete, bulk operations | Always requires approval |

### Answers to expired or replaced approvals

The Temporal chat sends the pending `approvalId` with Approve, Decline and
Feedback requests to `POST /api/agents/fabric-ai/orchestrator-temporal/approve`.
After checking access to the execution, the route compares that ID with the
workflow's current pending approval. If no approval is pending or the supplied ID
does not match, it returns HTTP 409 with `code: "APPROVAL_NOT_PENDING"` and sends
no approval signal.

The hook classifies HTTP 409 as `stale`. It clears the old controls and approval
progress only if the current pending ID still matches the submitted ID. A newer
approval that arrived while the request was in flight stays visible. All three
handlers show `This approval was already answered or has expired.` and omit the
success notice used for an accepted decision.

The global fetch interceptor leaves HTTP 409 with `APPROVAL_NOT_PENDING` on this
exact approval pathname to the chat's handler, returning the original Response.
Other statuses, codes and paths retain their error reporting. This prevents a
duplicate generic AI failure notice for an expected stale answer.

The response contract is defined in
[`approval-response.ts`](../apps/web/modules/saas/agents/lib/approval-response.ts).
The route and workflow also check pending approval identity before accepting an
answer; clearing a card in the client grants no execution permission.

## Agent Delegation

The orchestrator adapts delegation based on agent capabilities from A2A cards:

| Agent Type | Delegation Mode | Orchestrator Behavior |
|------------|----------------|----------------------|
| Generalist (`autonomousExecution: true`) | `complete-task` | Passes full task as high-level goal |
| Specialist (`autonomousExecution: false`) | `single-step` | Decomposes into steps, delegates individually |

## Tool Discovery Token Optimization

- Tool definitions can consume 50K+ tokens if loaded upfront
- Orchestrator uses semantic matching to filter relevant tools per task
- Only matched tool schemas are included in the LLM context
- Result: ~99% token reduction vs loading all tools

## State Management

| Mechanism | Purpose |
|-----------|---------|
| `VariableContext` | Cross-step state passing |
| `OrchestratorWorkspace` | Context preservation across delegations |
| `Trajectory` | Execution history for learning |

## Advisor allowance and cached history

Ledgered Advisor turns retain raw input and output usage on request attempts.
Settled allowance charges input outside the read cache at full weight, plus a
ceiling-rounded tenth of reported cache-read input, plus output. Missing cache
breakdowns charge the full input. Cache writes remain full weight. Contract v1
accepts both old workers' full-weight settlements and new workers' weighted
settlements; deploy the nullable attempt column migration before new workers.
Old attempts may have a null cache-read count and settle at full input weight.

Reservations still use the full input estimate because cache hits are known
only after the response. The last part of an allowance smaller than one full
minimum reservation cannot be used; this is a deliberate conservative admission
rule. Raw usage telemetry remains suitable for provider usage accounting.

The weighted card starts from the latest ledger reading and adds raw recorded
usage after that reading, including completion-claim checks, delegation-risk
judgments and compaction (also when its summary is empty). Capturing the cost
index with a new reading absorbs earlier costs without counting them twice.
Retention diagnostics recompute `afterRoom` after compaction charges.

Advisor cache anchors use the workflow messages' iteration tags: the preceding
request ends immediately before the first message of the newest recorded
round. This includes multi-call rounds and assistant-text/correction-note
rounds. The activity's map conversion preserves message indices; vision alters
parts only, and the host note is appended after marking. Without round tags,
only the rolling history anchor is used.

With `ADVISOR_TOOL_LOADING=call_tool`, new runs keep the provider's tool list
fixed for the whole answer. `search_tools` returns tool definitions as text
instead of attaching the tools, and two fixed tools act on what it found:
`get_tool_schema` returns a found tool's definition and `call_tool` runs it.
`call_tool` reaches only tools the request itself offered, or that search
returned on an earlier request of the same answer, with the first binding kept.
The real tool is resolved before risk checks, approval and dispatch, and history
keeps the `call_tool` wrapper. Leave the setting unset in shared environments
until tool bindings are re-checked right before dispatch and tool arguments are
validated against the tool's schema.

With `ADVISOR_HISTORY_RETENTION=bounded`, new runs retain earlier tool results
until the decision below selects a rewrite. A reset keeps the last three tool
pairs, the existing recent-iteration exemption, skill bodies, paged source
reads, frame windows, and pre-turn history. Clearable results need positive read
knowledge: a Fabric-owned read under the captured approval rules, or an explicit
read-only declaration recorded by the executor. MCP declarations come from the
server's `readOnlyHint: true`; connected GitHub tools use their static registry
flag; operation-registry tools use their declared READ access. Missing declarations
(including old activity results), writes, and ambiguous call ids remain kept.
Kept results contribute no reset savings; `keptNonReadOnlyResults` logs their count
without content. This guard is part of the undeployed bounded-v2 policy.
The bounded-v2 decision uses calibrated prompt size
`S = ceil((estimate + extra input) × factor)`, full uncalibrated minimum
reservation `R = estimate + extra input + 1,024`, serialized activity-input
bytes `B`, and ledger exploration room (allowance minus charged measured usage,
outstanding reservations, and finalization reserve). The soft cap `C` is
`min(100,000, floor(0.6 × context window))`, or 100,000 without a known window.
The context hard limit uses the known window itself.

The byte cap and context window are hard technical limits. Allowance triggers
are disabled when no turn ledger exists; size limits remain active. `S > C` and
approaching allowance pressure (`R <= room` but `R + 16,384 > room`) are soft
triggers. A refused reservation (`R > room`) bypasses the soft guards for a
rescue attempt. Without a technical hard limit, apply the full reset only if
it makes `R <= room`; an unrescuable request reaches the ledger unchanged and
ends the turn through existing allowance handling, without a ledgered
compaction call for refusal.

| Condition before the main request | Selected action |
|---|---|
| No size or allowance trigger | `append` unchanged. |
| Soft triggers only, and a reset or compaction rewrote the preceding round | `append` unchanged. |
| Soft triggers only, with no preceding-round rewrite | `reset` if eligible results free at least 20,000 calibrated tokens; otherwise `append`. The soft-only decision branch does not select compaction. |
| `R > room`, without a technical hard limit | Try the full reset without a savings floor or consecutive-round restriction. Apply it only if the resulting reservation fits; otherwise `append` unchanged. This branch does not select compaction. |
| `B > 512 KiB` or `S > context window` | `reset` without a savings floor or consecutive-round restriction. If a byte or context limit remains afterward, also try `compact`, retaining the reset's changes. |

For these trigger classes, the reset loop replaces all eligible read results
oldest first, with the protection and positive-read guards above enforcing
eligibility. It does not stop once a threshold clears; freeing that backlog
allows subsequent requests to append until another trigger fires. A reset with
no eligible results is a no-op. The soft-only consecutive-round guard prevents
adjacent rewrites, and its savings check enforces the 20,000-token floor for
approaching allowance pressure and soft size triggers. Refused-round resets
are the allowance exception: they may free less than 20,000 calibrated tokens
or follow a rewrite, but only when the original reservation would not fit and
the reset makes it fit. Technical byte/context limits keep their existing
reset and compaction handling when they overlap refusal.

The cumulative-spend compaction path is disabled for v2; the existing compactor
and its cooldown run only for an unresolved technical hard limit. The loop
applies the reset before invoking the compactor, preserving placeholders if cooldown,
short history, an empty summary, or a failed summary leaves compaction unchanged.
A changed reset or changed compaction records the round as a rewrite. If both
still leave a technical hard limit exceeded, existing over-limit request
handling remains in effect.

Calibration uses recorded provider input divided by the estimate, clamped to
0.25–2, with 1 when counts are missing. It does not discount reservations for
expected cache hits. History diagnostics record the action, reason, calibrated
size, soft/hard trigger flags, reservation, room, and tokens and bytes freed,
including in request and turn summaries. Refusal-only decisions use the reason
`allowance_refused`, including when the reset cannot rescue the request. Under
the weighted-allowance marker, the final budget card uses
the same charged ledger usage and turn allowance as the in-turn card; histories
without that marker retain the default denominator. Historical v1 runs retain
their 32,000-token policy; runs with the setting unset retain age pruning.

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
| `toolCallLearningCache` | Successful tool call patterns |

# Agent System

Dynamic agent creation, delegation, and execution on Temporal infrastructure.

- **Audience**: AI/Backend developers
- **Owner**: Agent team

---

## Agent Type Taxonomy

| Type | Framework Enum | Execution Pattern | Autonomy |
|------|---------------|-------------------|----------|
| Orchestrator | `ORCHESTRATOR` | Hub-and-spoke delegation via A2A | Coordinates, doesn't execute |
| Composable | `COMPOSABLE` | Hierarchical agent-as-tool | Calls other agents as tools |
| Specialist | `LANGGRAPH` / `CUSTOM` | Single-domain execution | Step-level, requires instructions |
| Generalist | (capability flag) | Autonomous multi-step | Task-level, self-planning |

## Existing Infrastructure

```
packages/agent-core/
├── src/adapter.ts          # AgentAdapter interface
├── src/registry.ts         # AgentRegistry for discovery
├── src/a2a/                # Agent-to-Agent protocol
├── src/hitl/               # Human-in-the-loop approval
└── src/adapters/           # LangGraph, Pydantic, etc.

packages/temporal/src/workflows/
├── goal-oriented-agent/    # Multi-iteration goal achievement
├── orchestrator/           # Multi-agent coordination
├── agent-execution.ts      # Basic agent execution
└── agent-supervisor.ts     # Supervisor pattern
```

## Delegation Strategy

### Generalist Detection

From A2A agent card (`/.well-known/agent.json`):

```typescript
interface AgentCardCapabilities {
  autonomousExecution?: boolean;
  taskDecomposition?: boolean;
  maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
  codeExecution?: boolean;
  browserAutomation?: boolean;
}
```

### Delegation Modes

| Mode | When | Orchestrator Behavior |
|------|------|----------------------|
| `complete-task` | `autonomousExecution: true` | Full task as high-level goal, agent handles planning |
| `single-step` | `autonomousExecution: false` | Decompose into steps, delegate individually with context |

## Agentic Loop Pattern

```
while not is_goal_achieved(conversation_history):
    next_action = llm_decide_next_action(goal, history, tools)
    result = execute_tool(next_action.tool, params)
    conversation_history.append({action, result})
return format_final_result(conversation_history)
```

Implementation: `packages/temporal/src/workflows/goal-oriented-agent/`

### Loop Controls

| Control | Mechanism |
|---------|-----------|
| Max iterations | Configurable per agent (default: 10) |
| Context pruning | Summarize old messages when approaching token limit |
| Goal completion | LLM judges whether task objective is met |
| Parallel sub-agents | Up to 6 concurrent workers via Temporal |

## Agent Registration

Agents register via `RegisteredAgent` table with:

- A2A endpoint URL
- Agent card (capabilities, skills, limitations)
- Health status (automatic health checks)
- Scope: `SYSTEM` (visible to all) or `USER`/`ORG` (tenant-isolated)

Discovery is dynamic via A2A protocol. No hardcoded agent registries.

## Protocols

| Protocol | Purpose | Key Endpoints |
|----------|---------|---------------|
| A2A | Agent-to-agent communication | `/.well-known/agent.json`, `/a2a/send` |
| AG-UI | Agent-to-UI streaming | State deltas, tool calls, HITL approval requests |

## Deployed Agents

| Agent | Port | Framework |
|-------|------|-----------|
| Document Generator | 8124 | LangGraph (TypeScript) |
| Project Doc Generator | 8125 | LangGraph (TypeScript) |
| Task Planner | 8126 | LangGraph (TypeScript) |
| Story Breakdown | 8127 | LangGraph (TypeScript) |
| Data Analyst | 8130 | LangGraph (TypeScript) |
| API Agent | 8131 | LangGraph (TypeScript) |
| Prompt Enhancer | 8134 | LangGraph (TypeScript) |
| CUGA Wrapper | 9999 | Python (CUGA backend) |

# CUGA Features Documentation

This document describes the CUGA-inspired (Conversational UX Guided Architecture) features implemented in the Fabric Portal AI agent system.

## Overview

CUGA patterns enhance AI agents with:
- **Task Decomposition with Risk Analysis** - Breaking down complex tasks into manageable subtasks with risk assessment
- **Reflection Loops** - Self-correction mechanisms for improved accuracy
- **Human-in-the-Loop (HITL)** - Human approval workflows for critical actions
- **CodeAct Pattern** - Code generation and sandboxed execution with reflection
- **Tool Shortlisting** - Intelligent tool selection for efficiency

---

## 1. Task Decomposition with Risk Analysis

### Location
- **Agent**: `agents/langchain/task-planner/`
- **UI Page**: `apps/web/app/(saas)/app/agents/task-planner/page.tsx`

### Features
- Breaks down features/requirements into hierarchical subtasks
- Assigns risk scores (0-1) to each task
- Identifies risk factors (technical complexity, dependencies, unknowns)
- Creates dependency graphs between tasks
- Generates parallel execution plans with time estimates

### State Schema
```typescript
interface DecomposedTask {
  id: string;
  parentId?: string;
  title: string;
  description: string;
  type: string;
  estimate: number;
  complexity: "low" | "medium" | "high";
  riskScore: number;
  riskFactors?: string[];
  parallelizable?: boolean;
}
```

### Usage
1. Navigate to `/app/agents/task-planner`
2. Describe a feature or project requirement
3. Agent returns decomposed tasks with risk analysis
4. Review execution plan with parallelization recommendations

---

## 2. Reflection Node (Reusable Module)

### Location
- **Package**: `packages/agent-core/src/reflection/`
- **Exports**: `ReflectionNode`, `createReflectionLoop`

### Features
- Generic reflection mechanism for any LangGraph agent
- Configurable maximum iterations
- Quality scoring with threshold-based iteration
- Structured feedback for self-improvement

### API
```typescript
import { createReflectionLoop, ReflectionNode } from "@repo/agent-core";

// Create a reflection loop for your agent
const reflectionLoop = createReflectionLoop({
  maxIterations: 3,
  qualityThreshold: 0.8,
  onReflection: (feedback) => console.log("Reflecting:", feedback),
});

// Or use the ReflectionNode class directly
const reflector = new ReflectionNode({
  evaluator: async (state) => ({
    score: 0.7,
    feedback: "Consider edge cases",
    shouldContinue: true,
  }),
});
```

### Integration Pattern
```typescript
// In your LangGraph StateGraph
graph.addNode("reflect", reflectionLoop.node);
graph.addEdge("generate", "reflect");
graph.addConditionalEdges("reflect", (state) =>
  state.reflectionComplete ? END : "generate"
);
```

---

## 3. Human-in-the-Loop (HITL) UI

### Location
- **Dialog Component**: `apps/web/modules/saas/agents/components/HITLDialog.tsx`
- **Hook**: `apps/web/modules/saas/agents/hooks/useHumanInLoop.ts`

### Features
- Three request types: `approval`, `input`, `choice`
- Timeout handling with configurable duration
- Progress indicator for time-sensitive requests
- Keyboard shortcuts (Enter to approve, Escape to dismiss)
- Multi-select support for choice requests

### Usage
```typescript
import { useHumanInLoop } from "@saas/agents/hooks/useHumanInLoop";
import { HITLDialog } from "@saas/agents/components/HITLDialog";

function MyAgentUI() {
  const { pendingRequest, hasActiveRequest, respond, dismiss } = useHumanInLoop();

  return (
    <>
      <HITLDialog
        request={pendingRequest}
        open={hasActiveRequest}
        onRespond={respond}
        onDismiss={dismiss}
      />
      {/* Your agent UI */}
    </>
  );
}
```

### Request Types

**Approval Request:**
```typescript
await requestHumanApproval({
  prompt: "Deploy to production?",
  title: "Deployment Confirmation",
});
```

**Input Request:**
```typescript
await requestHumanInput({
  prompt: "Enter the API endpoint URL",
  title: "Configuration",
});
```

**Choice Request:**
```typescript
await requestHumanChoice({
  prompt: "Select deployment target",
  options: [
    { value: "staging", label: "Staging" },
    { value: "prod", label: "Production" },
  ],
});
```

---

## 4. CodeAct Pattern (Code Executor Agent)

### Location
- **Agent**: `agents/langchain/code-executor/`
- **UI Page**: `apps/web/app/(saas)/app/agents/code-executor/page.tsx`
- **Sandbox**: `agents/langchain/code-executor/sandbox.ts`

### Features
- Sandboxed JavaScript execution using `isolated-vm`
- Memory limits (128MB default) and execution timeouts (5s default)
- Reflection loop for error recovery
- Maximum execution attempts with configurable limit
- Human approval before code execution (HITL)

### State Schema
```typescript
interface CodeExecutorState {
  task: string;
  code: string;
  result?: string;
  error?: string;
  executionCount: number;
  maxExecutions: number;
  isComplete: boolean;
  reflections?: string[];
}
```

### Security Features
- Isolated V8 context (no access to Node.js APIs)
- Memory and CPU limits
- No file system or network access
- Configurable allowed modules

---

## 5. Tool Shortlisting

### Location
- **Package**: `packages/agent-core/src/tool-shortlisting/`
- **Exports**: `ToolShortlister`, `RankedTool`, `ToolInfo`

### Features
- Semantic similarity ranking using embeddings
- Recent usage boosting
- Category-based filtering
- Configurable result limits

### API
```typescript
import { ToolShortlister, type ToolInfo } from "@repo/agent-core";

const shortlister = new ToolShortlister({
  embeddingModel: "text-embedding-ada-002",
  maxTools: 10,
  recencyBoost: 0.1,
});

const tools: ToolInfo[] = [
  { name: "search_web", description: "Search the web", category: "research" },
];

const ranked = await shortlister.rank(tools, "Find recent news about AI");
```

---

## Agent Registry

Both CUGA-enhanced agents are registered in:
- **CopilotKit Runtime**: `apps/web/app/api/copilotkit/route.ts`
- **Database Seed**: `packages/database/prisma/seed.ts`

### Task Planner (v2.0.0)
- Agent ID: `task_planner`
- Tags: `planning`, `tasks`, `development`, `risk-analysis`, `cuga`

### Code Executor (v1.0.0)
- Agent ID: `code_executor`
- Tags: `code`, `execution`, `sandbox`, `codeact`, `cuga`

---

## Testing

| Component | Tests | Location |
|-----------|-------|----------|
| Agent Core | 25 | `packages/agent-core/` |
| Task Planner | 16 | `agents/langchain/task-planner/` |
| Code Executor | 25 | `agents/langchain/code-executor/` |
| HITL UI | 18 | `apps/web/__tests__/agents/` |

```bash
pnpm --filter @repo/agent-core test
pnpm --filter task-planner-agent test
pnpm --filter code-executor-agent test
pnpm --filter web vitest run __tests__/agents/
```

---

## Environment Variables

```bash
TASK_PLANNER_URL=http://localhost:8128
CODE_EXECUTOR_URL=http://localhost:8129
```

---

## Related Documentation

- [Agent System](../../docs/agent-system.md)
- [AG-UI Protocol](./AG_UI_PROTOCOL_ANALYSIS.md)
- [CUGA Architecture](./CUGA_AGENT_ARCHITECTURE.md)

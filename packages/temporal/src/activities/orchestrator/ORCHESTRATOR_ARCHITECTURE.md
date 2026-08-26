# Orchestrator Architecture Documentation

## Overview

The Fabric AI Orchestrator is a sophisticated multi-agent orchestration system built on Temporal.io for durable workflow execution. It coordinates tasks by intelligently routing requests to specialized agents, MCP tools, and workflows while maintaining context across execution steps.

This document explains the enhanced orchestrator architecture, including the new modules added for context management, pre-planning research, and strategy-based execution.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Workflow Execution Flow](#workflow-execution-flow)
3. [Module Breakdown](#module-breakdown)
4. [Routing & Capability Discovery](#routing--capability-discovery)
5. [Planning & Execution Strategies](#planning--execution-strategies)
6. [Context Management](#context-management)
7. [Research Phase](#research-phase)
8. [Agent Delegation](#agent-delegation)
9. [MCP Tool Execution](#mcp-tool-execution)
10. [Workspace & RAG Integration](#workspace--rag-integration)
11. [Human-in-the-Loop Approval](#human-in-the-loop-approval)
12. [Memory & Learning](#memory--learning)
13. [Backward Compatibility](#backward-compatibility)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR WORKFLOW                               │
│                     (Temporal Durable Workflow)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │   Routing    │───▶│   Planning   │───▶│  Execution   │───▶│ Reflection│ │
│  │   Activity   │    │   Activity   │    │   Activity   │    │  Activity │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └───────────┘ │
│         │                   │                   │                           │
│         ▼                   ▼                   ▼                           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      ORCHESTRATOR ACTIVITIES                          │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │                                                                       │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌───────────┐ │  │
│  │  │ routing │  │planning │  │execution│  │delegation│  │  context  │ │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └──────────┘  └───────────┘ │  │
│  │                                                                       │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌───────────┐ │  │
│  │  │research │  │ policy  │  │approval │  │trajectory│  │   utils   │ │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └──────────┘  └───────────┘ │  │
│  │                                                                       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL SYSTEMS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐│
│  │   Agents   │  │ MCP Tools  │  │  Workflows │  │   Memory Systems       ││
│  │   (A2A)    │  │  (MCP SDK) │  │ (Temporal) │  │ (Letta + Qdrant)       ││
│  └────────────┘  └────────────┘  └────────────┘  └────────────────────────┘│
│                                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                            │
│  │ Workspaces │  │    RAG     │  │   Policy   │                            │
│  │  (Qdrant)  │  │  (Vector)  │  │   Engine   │                            │
│  └────────────┘  └────────────┘  └────────────┘                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Workflow Execution Flow

The orchestrator workflow executes in distinct phases:

### Phase 0: Initialization
- Retrieve workspace documents for RAG context
- Initialize Letta semantic memory agent
- Check for trajectory replay (save_reuse mode)

### Phase 1: Policy Enrichment
- Apply organizational policies to the request
- Enrich system prompt with policy constraints
- Block requests that violate policies

### Phase 2: Routing Analysis
- Discover available capabilities (agents, tools, workflows)
- Analyze task requirements and information needs
- Select primary agent and delegation mode
- Determine if MCP tools can handle task directly

### Phase 3: Research (NEW)
- Execute pre-planning research if strategy requires
- Gather context from web, workspaces, and agents
- Synthesize findings into actionable context

### Phase 4: Planning
- Select execution strategy based on task complexity
- Create task plan with phases and steps
- Identify parallelizable step groups
- Assess risk and approval requirements

### Phase 5: Approval (HITL)
- Request human approval for high-risk operations
- Wait for approval signal
- Handle rejection gracefully

### Phase 6: Execution
- Execute steps according to strategy
- Manage context flow between steps
- Handle parallel execution where possible
- Retry failed steps with exponential backoff

### Phase 7: Reflection & Learning
- Evaluate execution quality
- Record patterns in Letta memory
- Store trajectory in Qdrant for future reuse

---

## Module Breakdown

### Core Modules (Existing, Enhanced)

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `routing/` | Task analysis and agent selection | `analyze-and-route.ts`, `capability-registry.ts` |
| `planning/` | Task decomposition and strategy | `create-task-plan.ts`, `enhanced-planner.ts`, `execution-strategies.ts` |
| `execution/` | Step execution and coordination | `execute-step.ts`, `execute-mcp-tool.ts`, `strategy-executor.ts` |
| `delegation/` | Agent communication via A2A | `delegate-to-agent.ts`, `message-builder.ts`, `resolve-endpoint.ts` |
| `policy/` | Policy enforcement and validation | `apply-policy-enrichment.ts`, `reflect-on-output.ts` |

### New Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `context/` | Context management and synthesis | `analyze-requirements.ts`, `synthesize-context.ts`, `context-bag.ts` |
| `research/` | Pre-planning research agent | `research-agent.ts`, `research-tools.ts` |

### Support Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `utils/` | Shared utilities | `json-parser.ts`, `index.ts` |
| `approval/` | HITL approval workflows | `create-approval-request.ts`, `get-approval-status.ts` |
| `trajectory/` | Execution history storage | For save_reuse mode |

---

## Routing & Capability Discovery

### Capability Registry (NEW)

The new `capability-registry.ts` provides unified discovery of all available capabilities:

```typescript
// Discover all capabilities available to the orchestrator
const capabilities = await discoverCapabilities({
  userId,
  organizationId,
  enabledMcpConfigIds,
  enabledAgentIds,
});

// Returns unified Capability[] with:
// - Agents from database (SYSTEM, USER, ORGANIZATION scoped)
// - MCP tools from configured servers
// - Skills, input/output types, risk levels
```

### Capability Matching

Capabilities are matched to tasks using:

1. **Skill Matching** - Keywords from capability skills vs task description
2. **Description Matching** - Semantic overlap with task
3. **Information Need Matching** - Can capability fulfill required information?

```typescript
const matches = matchCapabilities(task, informationNeeds, capabilities);
// Returns CapabilityMatch[] sorted by relevance score
```

### Routing Decision

The routing activity produces a `RoutingDecision`:

```typescript
interface RoutingDecision {
  primaryAgent: string;           // Agent to handle task
  secondaryAgents: string[];      // Backup agents
  useMcpDirect: boolean;          // Use MCP tools without agent?
  isGeneralistAgent: boolean;     // Can agent decompose task itself?
  delegationMode: "complete-task" | "single-step";
  matchedMcpTools: string[];      // Tools that matched request
  riskLevel: "low" | "medium" | "high" | "critical";
  isReadOnly: boolean;            // No approval needed?
  agentCapabilities?: AgentCardCapabilities;
}
```

---

## Planning & Execution Strategies

### Execution Strategies (NEW)

The enhanced planner supports 5 execution strategies:

| Strategy | Use Case | Flow |
|----------|----------|------|
| `research-then-generate` | PRD, reports, analysis | Research → Synthesize → Generate |
| `iterative-refinement` | Creative content, code | Generate → Review → Refine (loop) |
| `parallel-gather` | Multi-source data gathering | Parallel gather → Merge → Synthesize |
| `hierarchical-delegation` | Complex multi-agent tasks | Decompose → Delegate → Aggregate |
| `direct-execution` | Simple single-step tasks | Execute directly |

### Strategy Selection

Strategy is selected based on task analysis:

```typescript
function selectExecutionStrategy(analysis: TaskAnalysis): ExecutionStrategy {
  // Research keywords → research-then-generate
  if (hasResearchIndicators(analysis)) return "research-then-generate";

  // Multiple data sources → parallel-gather
  if (analysis.dataSources.length > 2) return "parallel-gather";

  // Creative/iterative keywords → iterative-refinement
  if (hasIterativeIndicators(analysis)) return "iterative-refinement";

  // Multiple specialized agents needed → hierarchical-delegation
  if (analysis.requiredAgents.length > 1) return "hierarchical-delegation";

  // Simple task → direct-execution
  return "direct-execution";
}
```

### Enhanced Task Plan

The enhanced planner creates plans with phases:

```typescript
interface EnhancedTaskPlan {
  strategy: ExecutionStrategy;
  phases: TaskPhase[];              // Ordered execution phases
  parallelizableGroups: string[][]; // Steps that can run in parallel
  estimatedSteps: number;
  riskAssessment: PlanRiskAssessment;
  contextRequirements: ContextRequirement[];
}

interface TaskPhase {
  id: string;
  name: string;                     // e.g., "Research", "Generate", "Review"
  description?: string;
  steps: TaskStep[];
  order: number;
}
```

---

## Context Management

### Context Bag (NEW)

The `ContextBag` is a structured container that flows through execution:

```typescript
interface ContextBag {
  // Research findings organized by query
  research: Map<string, ResearchResult>;

  // Outputs from completed steps
  stepOutputs: Map<string, StepOutput>;

  // Cross-agent variables
  variables: Record<string, AgentVariable>;

  // Artifacts (code, files, etc.)
  artifacts: {
    code: CodeArtifact[];
    files: FileArtifact[];
    drafts: DraftArtifact[];
    outputs: OutputArtifact[];
  };

  // Synthesized context summary
  synthesized: {
    summary?: string;
    keyFacts: string[];
    confidence: number;
  };
}
```

### Context Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Research   │────▶│   Step 1    │────▶│   Step 2    │────▶ ...
│   Phase     │     │  Execution  │     │  Execution  │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│                    Context Bag                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ research │  │ step     │  │ variables│          │
│  │ results  │  │ outputs  │  │          │          │
│  └──────────┘  └──────────┘  └──────────┘          │
└─────────────────────────────────────────────────────┘
```

### Context for Delegation

When delegating to an agent, context is formatted appropriately:

```typescript
const message = buildContextualDelegationMessage({
  step,
  originalTask,
  contextBag,
  previousStepResults,
  agentCapabilities,
});

// Produces:
// ## Task
// [Original task description]
//
// ## Context from Research
// [Synthesized research findings]
//
// ## Previous Step Results
// [Relevant outputs from earlier steps]
//
// ## Your Specific Task
// [Step description with expected outputs]
```

---

## Research Phase

### Research Agent (NEW)

The research agent gathers context before task planning:

```typescript
// Execute research for information needs
const results = await executeResearchAgent({
  researchQueries: ["competitor analysis", "market trends"],
  informationNeeds: [
    { type: "market_data", description: "Current market size", priority: "required" },
    { type: "competitor", description: "Top 3 competitors", priority: "required" },
  ],
  originalTask: "Create a PRD for a new product",
  availableTools: ["firecrawl_search", "firecrawl_scrape"],
  availableAgents: ["market-researcher"],
  userId,
  organizationId,
});
```

### Research Tools (NEW)

Research tools are built dynamically based on available capabilities:

```typescript
const tools = await buildResearchTools(input);
// Returns:
// - webSearch: Search the web (if firecrawl available)
// - webScrape: Extract content from URLs
// - queryAgent: Query specialized agents for domain knowledge
```

### Research Flow

```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│ Analyze Info   │────▶│ Build Research │────▶│ Execute AI SDK │
│    Needs       │     │    Tools       │     │   generateText │
└────────────────┘     └────────────────┘     └────────────────┘
                                                      │
                                                      ▼
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│   Synthesize   │◀────│ Extract Key    │◀────│  Tool Calls    │
│    Context     │     │    Facts       │     │   (Search,     │
└────────────────┘     └────────────────┘     │    Scrape)     │
                                              └────────────────┘
```

---

## Agent Delegation

### A2A Protocol

All agent communication uses Google's Agent-to-Agent (A2A) protocol:

```typescript
// Delegate to agent via A2A
const result = await delegateToAgent({
  agentId: "document-generator",
  message: "Generate executive summary",
  delegationMode: "single-step",
  userId,
  organizationId,
  timeout: 60000,
});
```

### Delegation Modes

| Mode | Description | Agent Responsibility |
|------|-------------|---------------------|
| `complete-task` | Full task delegation | Agent decomposes and executes entire task |
| `single-step` | Single step delegation | Agent executes one specific step |

### Generalist vs Specialist Agents

**Generalist Agents** (e.g., `cuga_generalist`):
- Have `autonomousExecution` + `taskDecomposition` capabilities
- Receive full workspace context
- Handle internal decomposition
- Return artifacts and workspace state

**Specialist Agents** (e.g., `document-generator`):
- Focus on specific domain
- Receive single step with context
- Return domain-specific output

### Workspace Inheritance

For generalist agents, the full workspace is passed:

```typescript
interface OrchestratorWorkspace {
  files: FileArtifact[];           // Generated files
  codeExecutions: CodeExecution[]; // Code run + output
  browserStates: BrowserState[];   // Screenshots, DOM
  completedSubtasks: Subtask[];    // Sub-task results
  variables: Record<string, AgentVariable>;
}
```

---

## MCP Tool Execution

### Direct MCP Execution

When routing decides `useMcpDirect: true`:

```typescript
const result = await executeMcpTool({
  toolName: "firecrawl_search",
  args: { query: "AI market trends 2025" },
  userId,
  organizationId,
});
```

### Tool Caching (Letta)

Before executing, check Letta cache:

```typescript
// Check cache
const cached = await getLettaToolCache(lettaAgentId, toolName, argsHash);
if (cached) return cached;

// Execute and cache
const result = await executeMcpTool(...);
await storeLettaToolCache(lettaAgentId, toolName, argsHash, result);
```

### Risk-Based Tool Filtering

Tools are filtered by risk level per step:

```typescript
const allowedTools = filterToolsByRisk(allTools, step.riskLevel);
// LOW risk steps: read-only tools (get, list, search, fetch)
// MEDIUM risk steps: + update tools
// HIGH risk steps: + create tools
// CRITICAL risk steps: all tools (with approval)
```

---

## Workspace & RAG Integration

### Document Retrieval

Before routing, workspace documents are retrieved:

```typescript
const ragContext = await retrieveWorkspaceDocumentsActivity({
  workspaceIds: ["ws-123", "ws-456"],
  query: userMessage,
  topK: 5,
  minSimilarity: 0.3,
});
```

### Context Enrichment

RAG context is appended to the message:

```typescript
const enrichedMessage = `${userMessage}

## Relevant Documents
${ragContext.formattedContent}
`;
```

### Multi-Workspace Search

The orchestrator searches across multiple workspaces:

```typescript
// Per-workspace Qdrant collections
for (const workspaceId of workspaceIds) {
  const chunks = await qdrant.search({
    collection: `workspace-${workspaceId}`,
    vector: messageEmbedding,
    topK: 5,
  });
  results.push(...chunks);
}
```

---

## Human-in-the-Loop Approval

### Approval Triggers

Approval is required for:
- Write operations (create, update, delete)
- High/critical risk routes
- Steps marked `requiresApproval: true`

### Approval Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Risk        │────▶│ Create      │────▶│ Wait for    │
│ Assessment  │     │ Approval    │     │ Signal      │
│ (High?)     │     │ Request     │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
                                              │
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                   ▼
                    ┌───────────┐       ┌───────────┐       ┌───────────┐
                    │ Approved  │       │ Rejected  │       │ Timeout   │
                    │ Continue  │       │ Stop      │       │ Fail      │
                    └───────────┘       └───────────┘       └───────────┘
```

### Approval Signal

```typescript
// In workflow
const approval = await condition(
  () => approvalReceived,
  approvalTimeout
);

// From client
await workflow.signal("approvalSignal", {
  approved: true,
  feedback: "Looks good",
});
```

---

## Memory & Learning

### Letta Memory (Structured)

Per-user semantic memory agent:
- Tool execution history
- Routing patterns
- Success/failure tracking
- Tool result caching

### Qdrant Memory (Vector)

Execution trajectory storage:
- Complete execution summaries
- Semantic search for similar tasks
- Hybrid routing suggestions

### Trajectory Replay (save_reuse mode)

```typescript
// Check for similar past execution
const similar = await findSimilarTrajectory({
  query: userMessage,
  userId,
  threshold: 0.85,
});

if (similar) {
  // Replay with adaptation
  return replayTrajectory(similar, currentContext);
}
```

---

## Backward Compatibility

### No Breaking Changes

The enhanced orchestrator maintains full backward compatibility:

1. **Existing Activities**: All existing activities (`analyzeAndRoute`, `createTaskPlan`, `executeStep`) continue to work unchanged

2. **Existing Types**: Existing type definitions are preserved, new fields are optional

3. **Default Strategy**: Without explicit strategy selection, `direct-execution` is used (matches previous behavior)

4. **Optional Research**: Research phase only runs when strategy requires it

5. **Gradual Adoption**: New features can be enabled incrementally via `executionMode`

### Migration Path

| Feature | Enablement |
|---------|------------|
| Context Bag | Automatic for all executions |
| Research Phase | Only with `research-then-generate` strategy |
| Strategy Selection | Based on task analysis (automatic) |
| Enhanced Planning | Only with `balanced`/`accurate` modes |
| Parallel Execution | Automatic when strategy supports it |

### Feature Flags

```typescript
interface OrchestratorWorkflowInput {
  // Existing fields preserved
  executionMode?: "fast" | "balanced" | "accurate" | "save_reuse";

  // New optional fields
  enableResearch?: boolean;        // Force research phase
  forceStrategy?: ExecutionStrategy; // Override auto-selection
}
```

---

## Summary

The enhanced orchestrator architecture adds:

1. **Pre-Planning Research** - AI SDK-powered research agent gathers context before task execution

2. **Execution Strategies** - 5 strategies for different task patterns (research-then-generate, iterative-refinement, parallel-gather, hierarchical-delegation, direct-execution)

3. **Context Management** - Structured ContextBag flows through execution, enabling rich context for each step

4. **Capability Registry** - Unified discovery and matching of agents, tools, and workflows

5. **Strategy Execution** - Phase-based execution with parallel step support

All while maintaining **100% backward compatibility** with existing orchestrator behavior. The enhancements are additive and can be adopted gradually.

---

## File Reference

```
packages/temporal/src/activities/orchestrator/
├── index.ts                          # Main exports
├── types.ts                          # Type definitions
├── ORCHESTRATOR_ARCHITECTURE.md      # This document
│
├── context/                          # NEW: Context management
│   ├── index.ts
│   ├── analyze-requirements.ts       # Information need analysis
│   ├── synthesize-context.ts         # Context synthesis
│   └── context-bag.ts                # ContextBag management
│
├── research/                         # NEW: Pre-planning research
│   ├── index.ts
│   ├── research-agent.ts             # AI SDK research agent
│   └── research-tools.ts             # Dynamic tool builder
│
├── routing/                          # Task routing
│   ├── index.ts
│   ├── analyze-and-route.ts          # Main routing logic
│   └── capability-registry.ts        # NEW: Unified capability discovery
│
├── planning/                         # Task planning
│   ├── index.ts
│   ├── create-task-plan.ts           # Plan creation
│   ├── enhanced-planner.ts           # NEW: Strategy-based planner
│   └── execution-strategies.ts       # NEW: Strategy definitions
│
├── execution/                        # Step execution
│   ├── index.ts
│   ├── execute-step.ts               # Step execution
│   ├── execute-mcp-tool.ts           # MCP tool execution
│   ├── execute-agent-as-tool.ts      # Agent as tool execution
│   └── strategy-executor.ts          # NEW: Strategy-based executor
│
├── delegation/                       # Agent delegation
│   ├── index.ts
│   ├── delegate-to-agent.ts          # A2A delegation
│   ├── resolve-endpoint.ts           # Endpoint resolution
│   ├── agent-capabilities.ts         # Capability detection
│   └── message-builder.ts            # ENHANCED: Contextual messages
│
├── policy/                           # Policy enforcement
│   ├── index.ts
│   ├── apply-policy-enrichment.ts
│   ├── reflect-on-output.ts
│   └── validate-with-altk.ts
│
├── approval/                         # HITL approval
│   ├── index.ts
│   ├── create-approval-request.ts
│   ├── get-approval-status.ts
│   └── update-execution-progress.ts
│
├── workflow/                         # Workflow triggering
│   ├── index.ts
│   └── trigger-workflow.ts
│
└── utils/                            # Shared utilities
    ├── index.ts
    └── json-parser.ts
```

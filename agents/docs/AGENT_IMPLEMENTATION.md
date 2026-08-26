# Agent Implementation Guide

This document provides a comprehensive guide for implementing new agents in the fabric-portal application.

## Table of Contents

1. [Database Schema Overview](#database-schema-overview)
2. [Agent Architecture](#agent-architecture)
3. [Agent Implementation Patterns](#agent-implementation-patterns)
4. [Development Guidance](#development-guidance)
5. [Best Practices](#best-practices)
6. [AG-UI Native Agent Integration](#ag-ui-native-agent-integration)
7. [Architecture Gaps and Improvements](#architecture-gaps-and-improvements)
8. [CUGA-Informed Orchestrator, API Agent, and Browser Agent Roadmap](#cuga-informed-orchestrator-api-agent-and-browser-agent-roadmap)

---

## Database Schema Overview

### Current State

The Prisma schema is well-defined and comprehensive in `packages/database/prisma/schema.prisma`. The database connection is properly configured in `.env.local`:
- **Database URL**: `postgresql://postgres:postgres@localhost:5432/fabric`
- **Connection**: Points to Aspire-managed PostgreSQL on port 5432

### Agent-Related Models

#### Agent Model (Lines 396-427)

The core agent registration model with the following key features:

```prisma
model Agent {
  id              String         @id @default(cuid())
  agentId         String         @unique
  name            String         // Internal name (e.g., "prd-generator")
  displayName     String         // User-friendly name
  description     String?
  framework       AgentFramework // LANGGRAPH, MICROSOFT, PYDANTIC_AI, etc.
  runtimeVersion  String         @default("v1")
  deploymentUrl   String?        // DEPRECATED for multi-tenant runtime
  status          AgentStatus    @default(ACTIVE)
  scope           AgentScope     @default(USER)
  userId          String
  organizationId  String?
  config          Json?          // Model, temperature, mcpServers, etc.
  metadata        Json?
  createdAt       DateTime
  updatedAt       DateTime
  lastHealthCheck DateTime?
  lastDeployedAt  DateTime?
}
```

**Key Features**:
- Multi-tenancy support (userId + organizationId)
- Three scope levels: SYSTEM, ORGANIZATION, USER
- Framework-agnostic (supports 7 frameworks: LANGGRAPH, MICROSOFT, PYDANTIC_AI, CREWAI, AUTOGEN, OPENAI, CUSTOM)
- Configuration stored as JSON for flexibility
- Runtime version for multi-tenant workers

#### AgentTask Model (Lines 457-487)

Tracks individual agent execution tasks with:
- **Status tracking**: "pending", "running", "completed", "failed", "approved", "rejected"
- **Stage tracking**: "requirements", "prd", "architecture", etc.
- **Temporal workflow integration**: workflowId, runId fields
- **Input/output/state storage**: JSON fields for flexibility
- **Multi-tenancy enforcement**: userId and organizationId

#### AgentApproval Model (Lines 490-508)

Human-in-the-loop approval workflow:
- Tracks approval decisions
- Stores proposed changes
- Captures user feedback
- Confidence scoring

#### Supporting Models

- **SDLCArtifact**: Stores generated artifacts (PRDs, diagrams, code)
- **SDLCPipeline**: Tracks complete SDLC compression pipelines
- **MCPConfig**: MCP server configurations for agent tools
- **Prompt**: Prompt library for agent system prompts

### Schema Synchronization

To verify and synchronize the schema:

```bash
# From repository root
pnpm --filter @repo/database generate
pnpm --filter @repo/database push  # For dev
# OR
pnpm --filter @repo/database migrate deploy  # For production
```

---

## Agent Architecture

The fabric-portal implements a **sophisticated dual-layer agent architecture**:

### Architecture Layers

#### Layer 1: In-Memory Agent Registry

**Location**: `packages/agent-core/`

**Purpose**: Runtime agent discovery and health monitoring

**Implementation**: `AgentRegistry` class with `globalAgentRegistry` singleton

**Key Features**:
- Framework-agnostic adapter pattern
- CopilotKit integration
- Health monitoring
- Agent discovery by framework/language/tags
- Metadata for UI display

**Registered Agents** (from `apps/web/app/api/copilotkit/route.ts`):
1. `document_generator` - General document generation
2. `project_document_generator` - Project-scoped with RAG context

#### Layer 2: Database-Backed Agent Registry

**Location**: PostgreSQL database (Agent table)

**Purpose**: Persistent agent storage and multi-tenant management

**Key Features**:
- User-created dynamic agents
- Multi-tenancy (USER/ORGANIZATION/SYSTEM scopes)
- Configuration-driven agent creation
- No deployment required (multi-tenant runtime)

### Agent Relationships

```
User/Organization
    ↓
  Agent (Database)
    ↓
  AgentTask (Execution tracking)
    ↓
  ├─ AgentApproval (Human-in-loop)
  ├─ SDLCArtifact (Generated outputs)
  └─ Temporal Workflow (Durability)
```

### Agent Lifecycle

1. **Creation** (Database):
   - User creates agent via UI (`CreateAgentDialog`)
   - API endpoint: `POST /api/agents/registry/create`
   - Stored in Agent table with config JSON
   - Status: ACTIVE (immediately available)

2. **Configuration**:
   - System prompt from Prompt Library
   - MCP tools from MCPConfig
   - Model settings (temperature, maxTokens, etc.)
   - Predictive state mappings for AG-UI protocol

3. **Execution**:
   - Triggered via `POST /api/agents/trigger`
   - Creates AgentTask record
   - Starts Temporal workflow for durability
   - Streams responses via AG-UI protocol

4. **Storage**:
   - Task results in AgentTask.result
   - Generated artifacts in SDLCArtifact
   - Approval decisions in AgentApproval

### Where Agent Models Are Used

#### API Routes (`packages/api/modules/agents/`)

- `router.ts` - Main agent router
- `procedures/registry/` - CRUD operations
  - `create-registered-agent.ts`
  - `update-registered-agent.ts`
  - `delete-registered-agent.ts`
  - `list-registered-agents.ts`
  - `get-registered-agent.ts`
  - `get-agent-config.ts` (public endpoint for runtime)
- `procedures/trigger-agent.ts` - Execute agents
- `procedures/list-agent-tasks.ts` - Task history

#### Frontend Components (`apps/web/modules/saas/agents/`)

- `AgentRegistryView.tsx` - Database-backed agents
- `AgentList.tsx` - In-memory registry agents
- `UnifiedAgentView.tsx` - Combined view
- `CreateAgentDialog.tsx` - Agent creation form
- `AgentTaskList.tsx` - Task history
- `AgentRegistryTile.tsx` - Agent card display

#### Database Queries (`packages/database/prisma/queries/`)

- `agents.ts` - Agent CRUD operations
- `agent-tasks.ts` - Task tracking operations

#### Temporal Workflows (`packages/temporal/src/`)

- `workflows/agent-execution.ts` - Durable agent execution
- `activities/agent-execution.ts` - Agent execution activities

---

## Agent Implementation Patterns

### Current Agent Framework: LangGraph (Primary)

The codebase uses **LangGraph** as the primary agent framework with native AG-UI protocol support.

### Pattern 1: Static LangGraph Agents (Current Implementation)

**Example**: Document Generator Agent (`agents/langchain/document-generator/`)

**Structure**:
```
agents/langchain/document-generator/
├── agent.ts          # LangGraph workflow definition
├── server.ts         # LangGraph CLI entry point
├── types.ts          # Type definitions
└── langgraph.json    # LangGraph CLI config
```

**Key Components**:

#### 1. State Definition (using LangGraph Annotation)

```typescript
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";

export const AgentStateAnnotation = Annotation.Root({
  document: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  focusAnchor: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  documentType: Annotation<DocumentType>({
    reducer: (x, y) => y ?? x,
    default: () => "general",
  }),
  error: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  retryCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
  ...MessagesAnnotation.spec,  // CopilotKit compatibility
});

export type AgentState = typeof AgentStateAnnotation.State;
```

#### 2. Graph Definition

```typescript
const workflow = new StateGraph(AgentStateAnnotation);
workflow.addNode("chat_node", chatNode);
workflow.addEdge(START, "chat_node");
workflow.addEdge("chat_node", END);
export const graph = workflow.compile();
```

#### 3. Tool Integration

```typescript
import { WRITE_DOCUMENT_TOOL } from "@repo/agent-tools";

const modelWithTools = model.bindTools([WRITE_DOCUMENT_TOOL], {
  parallel_tool_calls: false,
});
```

#### 4. Predictive State Updates (AG-UI Protocol)

```typescript
runnableConfig.metadata.predict_state = [
  {
    state_key: "document",
    tool: "write_document_local",
    tool_argument: "document",
  },
  {
    state_key: "focusAnchor",
    tool: "write_document_local",
    tool_argument: "focusAnchor",
  },
];
```

### Pattern 2: Dynamic LangGraph Agents (Planned Architecture)

**Documentation**: `agents/docs/LANGGRAPH_DYNAMIC_AGENT_TECHNICAL_SPEC.md`

**Concept**: Database-driven agent generation without code deployment

**Workflow**:
1. User creates agent via UI
2. Agent config stored in database
3. LangGraph runtime fetches config via API
4. Runtime generates LangGraph workflow dynamically
5. Workflow cached in memory for performance

**Benefits**:
- No code deployment required
- User-configurable agents
- Multi-tenant isolation
- MCP tool integration
- Prompt library integration

### Pattern 3: Framework-Agnostic Adapter Pattern

**Location**: `packages/agent-core/src/adapter.ts`

**Interface**:
```typescript
export interface AgentAdapter<TState extends BaseAgentState> {
  readonly name: string;
  readonly framework: string;  // "langgraph", "microsoft", etc.
  readonly language: string;   // "typescript", "python", "csharp"
  readonly config: AgentConfig;
  readonly tools: ToolDefinition[];

  getDeploymentUrl(): string;
  healthCheck(): Promise<AgentHealthStatus>;
  getMetadata(): AgentMetadata;
}
```

**Implementations**:
- `LangGraphAgentAdapter` - LangGraph agents (TS/Python)
- `MicrosoftAgentAdapter` - Microsoft Semantic Kernel agents
- `PydanticAIAdapter` - Pydantic AI agents

### Is There a Generic Agent Framework?

**Yes!** The codebase provides:

1. **AgentAdapter Interface** - Framework-agnostic abstraction
2. **AgentRegistry** - Unified agent management
3. **AG-UI Protocol** - Standardized communication
4. **BaseAgentState** - Common state structure (`packages/agent-types/`)

### LangGraph vs LangChain

**Primary Framework**: **LangGraph** (not LangChain)

- LangGraph is used for all agent implementations
- LangChain is a dependency (LangGraph is built on LangChain)
- LangGraph provides state management and graph-based workflows
- Native AG-UI protocol support in LangGraph

### Configuration-Driven vs Custom Code

**Current**: **Custom Code** (each agent has its own implementation)

**Future**: **Configuration-Driven** (dynamic agent generation)

The architecture supports both:
- **Static agents**: Pre-deployed with custom code (current)
- **Dynamic agents**: Database-driven configuration (planned)

---

## Development Guidance

### Creating New Specialized Agents

#### Option A: Static LangGraph Agent (Recommended for Complex Agents)

**Use Case**: Agents with specialized logic, custom tools, or complex workflows

**Steps**:

##### 1. Create Agent Directory

```bash
mkdir -p agents/langchain/your-agent-name
cd agents/langchain/your-agent-name
```

##### 2. Define Agent State (`agent.ts`)

```typescript
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";
import type { BaseAgentState } from "@repo/agent-types";

export const AgentStateAnnotation = Annotation.Root({
  // Your custom state fields
  customField: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  ...MessagesAnnotation.spec,
});

export type AgentState = typeof AgentStateAnnotation.State;
```

##### 3. Implement Agent Logic

```typescript
import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";

async function chatNode(state: AgentState, config: RunnableConfig) {
  // Your agent logic
  const model = new ChatOpenAI({
    model: "gpt-4o",
    temperature: 0.7,
  });

  const response = await model.invoke(state.messages);

  return {
    messages: [response],
    customField: "updated value",
  };
}

const workflow = new StateGraph(AgentStateAnnotation);
workflow.addNode("chat_node", chatNode);
workflow.addEdge(START, "chat_node");
workflow.addEdge("chat_node", END);

export const graph = workflow.compile();
```

##### 4. Create Server Entry Point (`server.ts`)

```typescript
import { graph } from "./agent.js";

export { graph };

export const graphMetadata = {
  name: "your_agent_name",
  description: "Your agent description",
  version: "1.0.0",
  capabilities: ["capability1", "capability2"],
  supportsPredictiveUpdates: true,
};
```

##### 5. Configure LangGraph CLI (`langgraph.json`)

```json
{
  "dependencies": ["."],
  "graphs": {
    "your_agent_name": "./server.ts:graph"
  },
  "env": ".env.local"
}
```

##### 6. Register with CopilotKit (`apps/web/app/api/copilotkit/route.ts`)

```typescript
import { LangGraphAgentAdapter } from "@repo/agent-core";
import { globalAgentRegistry } from "@repo/agent-core";

registry.register(
  new LangGraphAgentAdapter({
    name: "your_agent_name",
    displayName: "Your Agent Name",
    description: "Your agent description",
    deploymentUrl: process.env.YOUR_AGENT_URL!,
    graphId: "your_agent_name",
    tools: [YOUR_CUSTOM_TOOL],
    language: "typescript",
    version: "1.0.0",
    agentConfig: {
      model: "gpt-4o",
      temperature: 0.7,
      maxTokens: 4000,
      timeout: 30000,
      recursionLimit: 25,
      predictiveStates: [
        {
          state_key: "your_state",
          tool: "your_tool",
          tool_argument: "arg"
        },
      ],
    },
  })
);
```

##### 7. Add to Aspire Orchestration (`.aspire/AppHost/Program.cs`)

```csharp
var yourAgent = builder.AddNpmApp("your-agent", "../agents/langchain/your-agent-name")
    .WithHttpEndpoint(port: 8127, env: "PORT")
    .WithEnvironment("YOUR_AGENT_URL", "http://localhost:8127")
    .PublishAsDockerFile();
```

##### 8. Add Environment Variable (`.env.local`)

```bash
# Your Agent Service
YOUR_AGENT_URL="http://localhost:8127"
```

#### Option B: Dynamic Database-Driven Agent (Recommended for Simple Agents)

**Use Case**: Agents with standard workflows, configurable prompts, and MCP tools

**Steps**:

##### 1. Create Agent via UI

- Navigate to `/app/admin/agents`
- Click "Create New Agent"
- Fill in configuration:
  - **Display Name**: User-friendly name
  - **Description**: What the agent does
  - **System Prompt**: Select from Prompt Library
  - **MCP Servers**: Select tools to enable
  - **Model Settings**: Configure model, temperature, etc.

##### 2. Agent is Immediately Available

- No deployment required
- Runs in shared LangGraph runtime
- Configuration stored in database
- Multi-tenant isolation enforced

### Shared Infrastructure to Reuse

#### 1. Agent Types (`packages/agent-types/`)

```typescript
import type {
  BaseAgentState,
  DocumentType,
  ProjectContext,
  ProjectAgentState,
} from "@repo/agent-types";
```

**Available Types**:
- `BaseAgentState` - Minimum state for all agents
- `ProjectAgentState` - Extended state for project-scoped agents
- `DocumentType` - Document type enum
- `ProjectContext` - Project metadata structure

#### 2. Agent Tools (`packages/agent-tools/`)

```typescript
import { WRITE_DOCUMENT_TOOL } from "@repo/agent-tools";
```

**Available Tools**:
- `WRITE_DOCUMENT_TOOL` - Write/update document content with focus anchor

#### 3. Agent Prompts (`packages/agent-prompts/`)

```typescript
import { getSystemPromptForDocumentType } from "@repo/agent-prompts";
```

**Available Functions**:
- `getSystemPromptForDocumentType()` - Get prompt for document type
- Prompt templates for PRDs, proposals, architecture docs

#### 4. Agent Core (`packages/agent-core/`)

```typescript
import {
  LangGraphAgentAdapter,
  globalAgentRegistry,
  type AgentAdapter,
  type AgentConfig,
} from "@repo/agent-core";
```

**Available Components**:
- `AgentAdapter` - Framework-agnostic interface
- `LangGraphAgentAdapter` - LangGraph implementation
- `AgentRegistry` - Agent management
- `globalAgentRegistry` - Singleton instance

#### 5. Database Queries (`packages/database/`)

```typescript
import {
  createAgent,
  listAgents,
  getAgentById,
  getAgentByAgentId,
  updateAgent,
  deleteAgent,
  createAgentTask,
  getAgentTaskById,
  updateAgentTaskStatus,
} from "@repo/database";
```

#### 6. Temporal Workflows (`packages/temporal/`)

```typescript
import { agentExecutionWorkflow } from "@repo/temporal";
```

**Available Workflows**:
- `agentExecutionWorkflow` - Durable agent execution
- `chatTitleGenerationWorkflow` - Chat title generation

---

## Best Practices

### 1. Start with Document Generator as Reference

The Document Generator (`agents/langchain/document-generator/`) is a well-structured example that:
- Implements all patterns correctly
- Has good error handling
- Uses predictive state updates
- Integrates with CopilotKit properly

### 2. Use Temporal Workflows for Durability

All agent executions should use Temporal workflows:
- Automatic retries and error handling
- Task tracking built-in
- Durable execution across failures
- Workflow history for debugging

**Example**:
```typescript
import { agentExecutionWorkflow } from "@repo/temporal";

// Trigger workflow
const handle = await client.workflow.start(agentExecutionWorkflow, {
  taskQueue: "agent-execution",
  workflowId: `agent-${taskId}`,
  args: [{
    agentId: "your_agent",
    userId: user.id,
    organizationId: org?.id,
    input: { /* your input */ },
  }],
});
```

### 3. Implement Multi-Tenancy from Day 1

Always include userId and organizationId:
- Filter data by tenant in all queries
- Enforce authorization at API level
- Validate organization membership
- Scope MCP servers by tenant

**Example**:
```typescript
// API procedure with multi-tenancy
export const listAgents = protectedProcedure
  .input(z.object({
    organizationId: z.string().optional(),
  }))
  .handler(async ({ input, context }) => {
    const { user } = context;

    // Filter by user and optional organization
    return await listAgents({
      userId: user.id,
      organizationId: input.organizationId,
    });
  });
```

### 4. Follow AG-UI Protocol

Use predictive state updates for real-time UI streaming:
- Define state keys in agent state
- Map state keys to tool arguments
- Emit proper events during execution
- Enable real-time UI updates

**Example**:
```typescript
runnableConfig.metadata.predict_state = [
  {
    state_key: "document",
    tool: "write_document_local",
    tool_argument: "document",
  },
  {
    state_key: "focusAnchor",
    tool: "write_document_local",
    tool_argument: "focusAnchor",
  },
];
```

### 5. Leverage Shared Infrastructure

Don't reinvent types, tools, or prompts:
- Use `@repo/agent-types` for state definitions
- Use `@repo/agent-tools` for common tools
- Use `@repo/agent-prompts` for prompt templates
- Use existing database queries
- Follow established patterns

### 6. Test with Different Scopes

Test your agent with all scope levels:
- **USER scope**: Personal agents for individual users
- **ORGANIZATION scope**: Shared agents for organization members
- **SYSTEM scope**: Platform-wide agents available to all

### 7. Implement Error Handling

Handle errors gracefully:
- Use try-catch blocks
- Store errors in AgentTask.error
- Implement retry logic with exponential backoff
- Provide user-friendly error messages

**Example**:
```typescript
async function chatNode(state: AgentState, config: RunnableConfig) {
  try {
    const response = await model.invoke(state.messages);
    return { messages: [response], error: undefined };
  } catch (error) {
    console.error("Agent execution failed:", error);
    return {
      error: error.message,
      retryCount: state.retryCount + 1,
    };
  }
}
```

### 8. Use AI Gateway for All LLM Calls

All AI requests must go through Vercel AI Gateway:
- Centralized monitoring
- Cost tracking
- Rate limiting
- Provider abstraction

**Example**:
```typescript
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY!,
  baseURL: "https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT/YOUR_GATEWAY/openai",
});
```

### 9. Document Your Agent

Create documentation for your agent:
- Purpose and use cases
- Configuration options
- Input/output schemas
- Example usage
- Troubleshooting guide

### 10. Monitor Agent Performance

Track agent metrics:
- Execution time
- Success/failure rates
- Token usage
- Cost per execution
- User satisfaction

---

## AG-UI Native Agent Integration

### Overview

The fabric-portal architecture supports **framework-agnostic agent integration** via the AG-UI protocol. Any agent that natively emits AG-UI events can be integrated directly into CopilotKit without requiring custom protocol translation layers.

### What is an AG-UI Native Agent?

An **AG-UI Native Agent** is any agent (written in any language/framework) that:
1. **Natively emits AG-UI protocol events** (STATE_DELTA, TOOL_CALL, TOOL_RESULT, etc.)
2. **Exposes HTTP/WebSocket endpoints** for communication
3. **Implements standard AG-UI event types** as defined in `packages/agent-core/src/ag-ui-protocol.ts`

### AG-UI Native Agent Adapter

The `AGUINativeAgentAdapter` is a generic adapter that works with any AG-UI-native agent, regardless of framework or language.

**Location**: `packages/agent-core/src/adapters/agui-native-adapter.ts`

**Usage**:

```typescript
import { AGUINativeAgentAdapter } from "@repo/agent-core/adapters";

// Python Pydantic AI agent
const pythonAgent = new AGUINativeAgentAdapter({
  name: "python_agent",
  displayName: "Python Agent",
  description: "Custom Python agent with AG-UI support",
  framework: "pydantic-ai",
  language: "python",
  deploymentUrl: "http://localhost:8000",
  tools: [MY_TOOL],
  agentConfig: {
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 4000,
    timeout: 30000,
  },
});

// C# Microsoft Agent Framework agent
const csharpAgent = new AGUINativeAgentAdapter({
  name: "csharp_agent",
  displayName: "C# Agent",
  description: "Custom C# agent with AG-UI support",
  framework: "microsoft-agent-framework",
  language: "csharp",
  deploymentUrl: "http://localhost:5000",
  tools: [MY_TOOL],
  agentConfig: {
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 4000,
    timeout: 30000,
  },
});

// Register agents
registry.register(pythonAgent);
registry.register(csharpAgent);
```

### Agent Metadata Endpoint

All AG-UI-native agents must expose a `/metadata` endpoint that returns agent metadata in the standard format.

**Endpoint**: `GET /metadata`

**Response Schema**:

```typescript
{
  "name": "my_agent",
  "displayName": "My Agent",
  "description": "Custom agent with AG-UI support",
  "framework": "pydantic-ai",
  "language": "python",
  "version": "1.0.0",
  "supportsAGUIProtocol": true,
  "agUIProtocolVersion": "1.0",
  "tools": [...],
  "capabilities": ["predictive-state-updates", "tool-calling"],
  "endpoints": {
    "invoke": "/invoke",
    "stream": "/stream",
    "health": "/health"
  }
}
```

**TypeScript Types**: `packages/agent-core/src/metadata.ts`

**Zod Validation**: `packages/agent-core/src/metadata-schema.ts`

### Agent Discovery

The fabric-portal provides an agent discovery endpoint that automatically fetches and validates agent metadata.

**API Endpoint**: `POST /agents/registry/discover`

**Usage**:

```typescript
const result = await client.agents.registry.discover({
  deploymentUrl: "http://localhost:8000",
  apiKey: "optional-api-key",
  timeout: 5000,
});

console.log("Agent discovered:", result.metadata.name);
console.log("Healthy:", result.healthy);
console.log("AG-UI Protocol:", result.validation.supportsAGUIProtocol);
```

**What it does**:
1. Fetches agent metadata from `{deploymentUrl}/metadata`
2. Validates AG-UI protocol support
3. Checks for required endpoints (`/invoke`, `/stream`, `/health`)
4. Performs health check
5. Returns agent configuration for registration

### Protocol Validation

When creating agents, you can optionally validate AG-UI protocol support:

```typescript
const agent = await client.agents.registry.create({
  name: "my_agent",
  displayName: "My Agent",
  framework: "PYDANTIC_AI",
  deploymentUrl: "http://localhost:8000",
  validateProtocol: true, // ← Enable protocol validation
});
```

**Validation checks**:
- ✅ Agent metadata is valid
- ✅ `supportsAGUIProtocol: true`
- ✅ Required endpoints exist (`/invoke`, `/stream`, `/health`)
- ✅ Health check passes

### Required Endpoints

All AG-UI-native agents must implement these endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/invoke` | POST | Single-turn agent execution |
| `/stream` | POST | Streaming agent execution |
| `/health` | GET | Health check |
| `/metadata` | GET | Agent metadata (optional but recommended) |

### Example: Python Pydantic AI Agent

**File**: `agent.py`

```python
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Dict, Any

app = FastAPI()

class AgentMetadata(BaseModel):
    name: str
    displayName: str
    description: str
    framework: str
    language: str
    version: str
    supportsAGUIProtocol: bool
    agUIProtocolVersion: str
    tools: List[Dict[str, Any]]
    capabilities: List[str]
    endpoints: Dict[str, str]

@app.get("/metadata")
async def get_metadata() -> AgentMetadata:
    return AgentMetadata(
        name="python_agent",
        displayName="Python Agent",
        description="Custom Python agent with AG-UI support",
        framework="pydantic-ai",
        language="python",
        version="1.0.0",
        supportsAGUIProtocol=True,
        agUIProtocolVersion="1.0",
        tools=[],
        capabilities=["predictive-state-updates", "tool-calling"],
        endpoints={
            "invoke": "/invoke",
            "stream": "/stream",
            "health": "/health",
        },
    )

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.post("/invoke")
async def invoke(request: Dict[str, Any]):
    # Implement agent logic
    # Emit AG-UI events
    pass

@app.post("/stream")
async def stream(request: Dict[str, Any]):
    # Implement streaming agent logic
    # Emit AG-UI events via SSE or WebSocket
    pass
```

### Example: C# Microsoft Agent Framework Agent

**File**: `Program.cs`

```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/metadata", () => new
{
    name = "csharp_agent",
    displayName = "C# Agent",
    description = "Custom C# agent with AG-UI support",
    framework = "microsoft-agent-framework",
    language = "csharp",
    version = "1.0.0",
    supportsAGUIProtocol = true,
    agUIProtocolVersion = "1.0",
    tools = new object[] { },
    capabilities = new[] { "predictive-state-updates", "tool-calling" },
    endpoints = new
    {
        invoke = "/invoke",
        stream = "/stream",
        health = "/health"
    }
});

app.MapGet("/health", () => new { status = "healthy" });

app.MapPost("/invoke", async (HttpContext context) =>
{
    // Implement agent logic
    // Emit AG-UI events
});

app.MapPost("/stream", async (HttpContext context) =>
{
    // Implement streaming agent logic
    // Emit AG-UI events via SSE
});

app.Run();
```

### Migration Guide

#### Migrating from MicrosoftAgentAdapter

**Before**:
```typescript
import { MicrosoftAgentAdapter } from "@repo/agent-core/adapters";

const agent = new MicrosoftAgentAdapter({
  name: "csharp_agent",
  displayName: "C# Agent",
  description: "Microsoft Agent Framework agent",
  deploymentUrl: "http://localhost:5000",
  apiKey: "optional-api-key",
  tools: [MY_TOOL],
  language: "csharp",
  version: "1.0.0",
  tags: ["csharp", "microsoft"],
  agentConfig: { model: "gpt-4o", temperature: 0.7, ... },
});
```

**After**:
```typescript
import { AGUINativeAgentAdapter } from "@repo/agent-core/adapters";

const agent = new AGUINativeAgentAdapter({
  name: "csharp_agent",
  displayName: "C# Agent",
  description: "Microsoft Agent Framework agent",
  framework: "microsoft-agent-framework", // ← Add framework
  language: "csharp",
  deploymentUrl: "http://localhost:5000",
  apiKey: "optional-api-key",
  tools: [MY_TOOL],
  version: "1.0.0",
  tags: ["csharp", "microsoft"],
  agentConfig: { model: "gpt-4o", temperature: 0.7, ... },
});
```

#### Migrating from PydanticAIAdapter

**Before**:
```typescript
import { PydanticAIAdapter } from "@repo/agent-core/adapters";

const agent = new PydanticAIAdapter({
  name: "python_agent",
  displayName: "Python Agent",
  description: "Pydantic AI agent",
  deploymentUrl: "http://localhost:8000",
  apiKey: "optional-api-key",
  tools: [MY_TOOL],
  language: "python",
  version: "1.0.0",
  tags: ["python", "pydantic"],
  agentConfig: { model: "gpt-4o", temperature: 0.7, ... },
});
```

**After**:
```typescript
import { AGUINativeAgentAdapter } from "@repo/agent-core/adapters";

const agent = new AGUINativeAgentAdapter({
  name: "python_agent",
  displayName: "Python Agent",
  description: "Pydantic AI agent",
  framework: "pydantic-ai", // ← Add framework
  language: "python",
  deploymentUrl: "http://localhost:8000",
  apiKey: "optional-api-key",
  tools: [MY_TOOL],
  version: "1.0.0",
  tags: ["python", "pydantic"],
  agentConfig: { model: "gpt-4o", temperature: 0.7, ... },
});
```

### When to Use Each Adapter

| Adapter | Use Case |
|---------|----------|
| `LangGraphAgentAdapter` | LangGraph agents (TypeScript/Python) with LangSmith tracing and graphId |
| `AGUINativeAgentAdapter` | All other AG-UI-native agents (Python, C#, TypeScript, etc.) |

**Key Difference**: `LangGraphAgentAdapter` provides LangGraph-specific features (LangSmith tracing, graphId, LangGraph Platform integration). For all other frameworks, use `AGUINativeAgentAdapter`.

---

## Architecture Gaps and Improvements

### Current Gaps

#### 1. Dynamic Agent Runtime Not Implemented

**Status**: Documentation exists, database schema ready, runtime implementation pending

**Impact**: All agents require code deployment

**Recommendation**: Implement Python runtime for dynamic agent generation

#### 2. Limited Agent Framework Support

**Status**: Only LangGraph fully implemented

**Impact**: Limited framework choice

**Recommendation**: Complete Microsoft, Pydantic AI adapter integrations

#### 3. No Agent Versioning

**Status**: Agents have version metadata but no version control

**Impact**: Risky updates, no rollback capability

**Recommendation**: Implement version control and rollback

#### 4. Limited Tool Ecosystem

**Status**: Only `WRITE_DOCUMENT_TOOL` implemented

**Impact**: Agents have limited capabilities

**Recommendation**: Expand tool library, integrate more MCP servers

### Recommended Improvements

#### 1. Implement Dynamic Agent Runtime (High Priority)

- Complete Python runtime implementation
- Add agent caching layer
- Implement configuration API
- Enable user-created agents without deployment

#### 2. Expand Tool Library (Medium Priority)

- Add more built-in tools (search, code execution, etc.)
- Integrate more MCP servers
- Create tool marketplace
- Document tool creation process

#### 3. Add Agent Versioning (Medium Priority)

- Version control for agent configurations
- Rollback capability
- A/B testing support
- Version comparison

#### 4. Enhance Monitoring (Low Priority)

- Agent performance metrics
- Cost tracking per agent
- Usage analytics
- Error tracking and alerting

---

## CUGA-Informed Orchestrator, API Agent, and Browser Agent Roadmap

This section summarizes the **multi-phase implementation plan** for bringing Fabric Portal's agent system closer to CUGA's capabilities while reusing existing infrastructure (LangGraph, Temporal, MCP, OpenAPI tools, AG-UI protocol).

> For CUGA architecture details, see: `agents/docs/CUGA_AGENT_ARCHITECTURE.md`.

### High-Level Architecture (with API Agent and Browser Agent roles)

The following diagram shows how the **Orchestrator Agent** coordinates specialized agents, including **API Agent** and **Browser Agent**, within the existing CopilotKit/AG-UI/Temporal stack:

```mermaid
flowchart TD
  UI[Next.js + CopilotKit UI] --> AGUI[AG-UI Protocol / Copilot Runtime]
  AGUI --> ORCH[Orchestrator Agent (LangGraph)]
  ORCH --> PLAN[Task Analyzer + Risk-Aware Planner]
  ORCH --> DOC[Document / PRD Agent]
  ORCH --> STORY[Story Breakdown Agent]
  ORCH --> TASK[Task Planner Agent]
  ORCH --> API_AGENT[API Agent (MCP + OpenAPI)]
  ORCH --> BROWSER_AGENT[Browser Agent (Playwright + Temporal)]
  API_AGENT --> TOOLS[MCP Clients + OpenAPI Tools + Workflow Nodes]
  BROWSER_AGENT --> BWF[Browser & Hybrid Temporal Workflows]
  TOOLS --> EXT[External APIs / SaaS Systems]
  TOOLS --> RAG[Qdrant / RAG]
  BWF --> EXT
```

**Key points:**

- The **Orchestrator Agent** is the central decision-maker that all complex CopilotKit requests pass through.
- **API Agent** and **Browser Agent** are *named roles implemented as LangGraph subgraphs* that the Orchestrator calls for specific subtasks.
- API Agent sits on top of existing **MCP clients**, **OpenAPI dynamic tools**, and **Temporal workflow nodes**.
- Browser Agent wraps existing **browser-automation** and **hybrid-execution** Temporal workflows.

### Phase 1 – Orchestrator & Planning Foundation

**Goal:** Make the Orchestrator the single front-door for complex tasks, with explicit planning and risk information.

**Core implementation tasks:**

- Extend the Orchestrator LangGraph state to include:
  - `plan`: structured list of subtasks with metadata.
  - `riskScores`: map of subtask → { score, category, rationale }.
  - `recommendedAgents` / `preferredMode`: suggested agent types (e.g., `API_AGENT`, `BROWSER_AGENT`, `document_generator`).
- Introduce dedicated nodes:
  - `task_analyzer`: extract intent, constraints, key entities from the user request.
  - `risk_planner`: generate `plan` + `riskScores` and propose `recommendedAgents`.
- Update the orchestration node (e.g., `run_agents`) to **consume the plan** instead of routing ad-hoc.
- Expose `plan` and `riskScores` via AG-UI predictive state so the UI can render a “Plan” panel.

**Why this is first:**

- It provides a shared backbone for **all later work** (API Agent, Browser Agent, HITL, reflection).
- It directly addresses CUGA's strength in **task decomposition with risk analysis**.

### Phase 2 – API Agent Role (MCP + OpenAPI)

**Goal:** Turn existing MCP + OpenAPI capabilities into a first-class **API Agent** that the Orchestrator can call.

**Core implementation tasks:**

- Define an `api-agent` LangGraph with state fields such as:
  - `taskDescription`
  - `candidateTools` (MCP + OpenAPI)
  - `selectedTool` (+ backups)
  - `requestSpec` (path/query/body/auth)
  - `rawResponse`
  - `validatedResult`
- Implement the following nodes:
  - `api_tool_discovery`: uses MCP configs and OpenAPI services to populate `candidateTools` for the current tenant.
  - `api_tool_shortlister`: ranks and chooses `selectedTool`.
  - `api_request_planner`: builds `requestSpec` (parameters, body, auth) from task + context.
  - `api_executor`: calls MCP tool or OpenAPI executor and stores `rawResponse`.
  - `api_response_validator`: performs structural checks and plugs into the shared reflection node (Phase 4).
- Wire the API Agent into the Orchestrator:
  - For subtasks with `type: "api"`, call `api-agent` and feed back `validatedResult` + metadata.
  - Ensure multi-tenancy by only discovering tools and configs for the active `{ userId, organizationId }`.

**Why this is second:**

- Leverages existing infrastructure (`@repo/openapi-tools`, MCP client factory, Temporal steps).
- Provides a clear home for all API-centric automation and integrations.

### Phase 3 – Browser Agent Role (Temporal + Playwright)

**Goal:** Model a **Browser Agent** that wraps existing Temporal workflows for browser and hybrid execution.

**Core implementation tasks:**

- Define a `browser-agent` LangGraph with state fields such as:
  - `taskDescription`
  - `siteContext`
  - `workflowMode` (`browser-only`, `api-first`, `browser-first`, etc.)
  - `executionId`
  - `result`
- Implement nodes:
  - `browser_plan`: decide `workflowMode` and site-specific strategy.
  - `browser_workflow_trigger`: start `browserAutomationWorkflow` or `hybridExecutionWorkflow` with appropriate arguments and correlation IDs.
  - `browser_result_collector`: wait for workflow completion and project outputs into `result`.
- Integrate with Orchestrator so that:
  - Subtasks identified as UI-centric or without reliable APIs are routed to `browser-agent`.
  - Browser actions are logged via the existing audit logging infrastructure.

**Why this is third:**

- Reuses existing Temporal workflows and activities.
- Makes the implicit “Browser Agent” role explicit and composable within LangGraph.

### Phase 4 – Reflection & Validation (Cross-Cutting)

**Goal:** Add a reusable **reflection/self-evaluation node** used by API Agent, Browser Agent, and document agents.

**Core implementation tasks:**

- Implement a shared `reflection_node` LangGraph component that:
  - Receives `candidateOutput`, `taskSpec`, and `constraints`.
  - Returns `status` (`ok` / `needs_fix`), `diagnostics`, and optional `fixedOutput`.
- Plug this node into:
  - `api_response_validator` in API Agent.
  - Browser Agent post-processing for scraped data.
  - Critical document agents (e.g., PRD generator) where regression risk is high.
- Implement simple retry policies where `fixedOutput` can be used for a single corrective retry.

**Why this is important:**

- Directly addresses CUGA's advantage in **reflection and self-evaluation**.
- Reduces silent failures in external integrations.

### Phase 5 – Human-in-the-Loop (HITL) Orchestration

**Goal:** Make Human-in-the-Loop approvals a first-class concern in Orchestrator, API Agent, and Browser Agent flows.

**Core implementation tasks:**

- Define policy rules that map **risk category** and **action type** to HITL requirements.
- Use existing `AgentApproval` model and AG-UI HITL events to:
  - Pause workflows at approval points (via Temporal signals).
  - Resume or cancel based on user decision.
- Build shared UI components for:
  - Listing pending approvals with context.
  - Approve/reject with comments.
  - Indicating “waiting for your approval” states in the Copilot UI.

**Why this matters:**

- Moves HITL from “protocol defined but UI partial” to a complete, production-ready workflow.

### Phase 6 – Observability & Performance

**Goal:** Provide clear visibility into agent and workflow health.

**Core implementation tasks:**

- Aggregate metrics from:
  - Temporal workflows (per workflow type).
  - AgentTask records (per agent).
  - External tool error rates (MCP/OpenAPI/Browser).
- Build one or more views (admin-only initially):
  - “Agent & Workflow Health” dashboard (success rates, latency, top errors).
  - Per-conversation or per-project audit trail of agent/tool activity.

### Recommended Initial Implementation Focus

For practical implementation, the **most beneficial next steps** are:

1. **Phase 1 – Orchestrator & Planning Foundation**
   - Establish the `plan` and `riskScores` structure.
   - Implement `task_analyzer` + `risk_planner` nodes.
   - Expose the plan to the UI via AG-UI predictive state.

2. **Phase 2 – API Agent Skeleton**
   - Create the `api-agent` graph and wire in tool discovery + shortlisting.
   - Integrate with Orchestrator for at least one concrete use case (e.g., Linear or GitHub via MCP/OpenAPI).

These two steps provide the highest leverage for subsequent work (Browser Agent, reflection, HITL) and can be implemented incrementally without disrupting existing agents.

---

## Summary

The fabric-portal has a **well-architected, production-ready agent infrastructure** with:

✅ **Comprehensive database schema** with Agent, AgentTask, AgentApproval models
✅ **Dual-layer architecture** (in-memory registry + database-backed registry)
✅ **Framework-agnostic adapter pattern** supporting multiple agent frameworks
✅ **LangGraph as primary framework** with native AG-UI protocol support
✅ **Multi-tenancy** at all layers (database, API, runtime)
✅ **Temporal workflows** for durable agent execution
✅ **CopilotKit integration** for real-time UI streaming
✅ **MCP integration** for dynamic tool loading
✅ **Prompt library** for centralized prompt management

### Next Steps for New Agent Development

1. Use Document Generator as reference implementation
2. Follow static LangGraph agent pattern for complex agents
3. Leverage shared infrastructure (types, tools, prompts)
4. Implement Temporal workflows for durability
5. Test multi-tenancy thoroughly
6. Consider contributing to dynamic agent runtime implementation

The architecture is solid and ready for expansion. The main gap is the dynamic agent runtime, which would enable user-created agents without code deployment.

---

## Additional Resources

### Documentation
- **LangGraph Documentation**: https://langchain-ai.github.io/langgraph/
- **CopilotKit Documentation**: https://docs.copilotkit.ai/
- **AG-UI Protocol Analysis**: `agents/docs/AG_UI_PROTOCOL_ANALYSIS.md`
- **Dynamic Agent Technical Spec**: `agents/docs/LANGGRAPH_DYNAMIC_AGENT_TECHNICAL_SPEC.md`

### Code References
- **AG-UI Protocol Types**: `packages/agent-core/src/ag-ui-protocol.ts`
- **Agent Metadata Types**: `packages/agent-core/src/metadata.ts`
- **Agent Metadata Validation**: `packages/agent-core/src/metadata-schema.ts`
- **AG-UI Native Adapter**: `packages/agent-core/src/adapters/agui-native-adapter.ts`
- **Agent Discovery Endpoint**: `packages/api/modules/agents/procedures/registry/discover-agent.ts`

---

**Last Updated**: 2025-11-17
**Version**: 1.0.0


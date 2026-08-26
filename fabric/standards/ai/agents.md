# AI Agent Development Standards

## Overview

This document defines standards for building AI agents in the Fabric Portal. Agents are autonomous or semi-autonomous systems that use LLMs to accomplish tasks, with support for multiple frameworks and protocols.

## When to Apply

- Creating new AI agents
- Integrating with agent frameworks (LangGraph, CopilotKit, etc.)
- Building agentic workflows
- Implementing human-in-the-loop patterns

## Core Principles

1. **Protocol Compliance** - Follow AG-UI protocol for interoperability
2. **Framework Agnostic** - Support multiple agent frameworks
3. **Observable** - Comprehensive logging and tracing
4. **Safe** - Human approval for sensitive actions

## Supported Frameworks

| Framework | Use Case | Status |
|-----------|----------|--------|
| **LangGraph** | Complex multi-step agents | Primary |
| **CopilotKit** | UI-integrated copilots | Supported |
| **Microsoft Semantic Kernel** | Enterprise agents | Supported |
| **Pydantic AI** | Structured output agents | Supported |
| **OpenAI Assistants** | Simple assistants | Supported |
| **Custom** | Special implementations | Supported |

## ✅ DO

### Agent Registration

**✅ DO**: Register agents with the agent registry

```typescript
// packages/agent-core/src/registry.ts
import type { AgentMetadata, AgentFramework } from "./types";

export interface RegisteredAgent {
  id: string;
  name: string;
  displayName: string;
  description: string;
  framework: AgentFramework;
  endpoint: string;
  supportedDocumentTypes?: string[];
  capabilities?: string[];
}

// Register at startup
export async function registerAgent(agent: RegisteredAgent): Promise<void> {
  await db.agent.upsert({
    where: { agentId: agent.id },
    create: {
      agentId: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      framework: agent.framework,
      deploymentUrl: agent.endpoint,
      status: "ACTIVE",
      scope: "SYSTEM",
      userId: "system",
    },
    update: {
      displayName: agent.displayName,
      description: agent.description,
      deploymentUrl: agent.endpoint,
      status: "ACTIVE",
    },
  });
}
```

### AG-UI Protocol Implementation

**✅ DO**: Implement AG-UI protocol for streaming

```typescript
// packages/agent-core/src/ag-ui-protocol.ts
import type { RunAgentInput, AgentEvent } from "@ag-ui/client";

export interface AGUIAdapter {
  // Stream events from agent
  stream(input: RunAgentInput): AsyncGenerator<AgentEvent>;
  
  // Get current state
  getState(): Promise<AgentState>;
  
  // Send user input/approval
  sendInput(input: UserInput): Promise<void>;
}

export abstract class BaseAGUIAdapter implements AGUIAdapter {
  abstract stream(input: RunAgentInput): AsyncGenerator<AgentEvent>;

  async *streamWithLogging(
    input: RunAgentInput,
  ): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();
    let eventCount = 0;

    try {
      for await (const event of this.stream(input)) {
        eventCount++;
        
        // Log significant events
        if (event.type === "tool_call" || event.type === "error") {
          console.log(`[Agent] Event: ${event.type}`, event);
        }

        yield event;
      }
    } finally {
      console.log(`[Agent] Stream completed`, {
        duration: Date.now() - startTime,
        eventCount,
      });
    }
  }
}
```

### LangGraph Agent Implementation

**✅ DO**: Structure LangGraph agents properly

```typescript
// agents/langchain/document-generator/src/graph.ts
import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { DocumentState } from "./types";

// Define state schema
interface DocumentGeneratorState {
  input: string;
  context: string;
  outline?: string;
  sections: string[];
  finalDocument?: string;
  currentStep: string;
  error?: string;
}

// Create the graph
export function createDocumentGeneratorGraph() {
  const model = new ChatOpenAI({
    modelName: "gpt-4-turbo-preview",
    temperature: 0.7,
  });

  const graph = new StateGraph<DocumentGeneratorState>({
    channels: {
      input: { value: null },
      context: { value: null },
      outline: { value: null },
      sections: { value: () => [] },
      finalDocument: { value: null },
      currentStep: { value: "start" },
      error: { value: null },
    },
  });

  // Add nodes
  graph.addNode("analyze", async (state) => {
    const analysis = await analyzeRequest(model, state.input, state.context);
    return { ...state, outline: analysis, currentStep: "generate_sections" };
  });

  graph.addNode("generate_sections", async (state) => {
    const sections = await generateSections(model, state.outline!);
    return { ...state, sections, currentStep: "assemble" };
  });

  graph.addNode("assemble", async (state) => {
    const document = assembleSections(state.sections);
    return { ...state, finalDocument: document, currentStep: "complete" };
  });

  // Add edges
  graph.addEdge("__start__", "analyze");
  graph.addEdge("analyze", "generate_sections");
  graph.addEdge("generate_sections", "assemble");
  graph.addEdge("assemble", END);

  return graph.compile();
}
```

### Human-in-the-Loop Patterns

**✅ DO**: Implement approval workflows for sensitive actions

```typescript
// packages/agent-core/src/approval.ts
export interface ApprovalRequest {
  taskId: string;
  agentId: string;
  action: string;
  changes: Record<string, unknown>;
  confidence: number;
  requiresApproval: boolean;
}

export async function requestApproval(
  request: ApprovalRequest,
): Promise<ApprovalResponse> {
  // Create approval record
  const approval = await db.agentApproval.create({
    data: {
      taskId: request.taskId,
      userId: request.userId,
      status: "PENDING",
      changes: request.changes,
      confidence: request.confidence,
    },
  });

  // Notify user (via WebSocket, email, etc.)
  await notifyUser(request.userId, {
    type: "approval_requested",
    approvalId: approval.id,
    action: request.action,
    preview: request.changes,
  });

  // Wait for decision (or timeout)
  const decision = await waitForApproval(approval.id, {
    timeout: "5m",
  });

  return decision;
}

// In agent workflow
async function executeWithApproval(
  action: AgentAction,
  context: AgentContext,
): Promise<ActionResult> {
  // Check if action requires approval
  if (action.requiresApproval || action.confidence < 0.8) {
    const approval = await requestApproval({
      taskId: context.taskId,
      agentId: context.agentId,
      action: action.type,
      changes: action.proposedChanges,
      confidence: action.confidence,
    });

    if (!approval.approved) {
      return { status: "rejected", feedback: approval.feedback };
    }
  }

  // Execute approved action
  return await executeAction(action);
}
```

### Prompt Management

**✅ DO**: Use the prompt library for agent prompts

```typescript
// packages/agent-prompts/src/index.ts
import { db } from "@repo/database";
import Handlebars from "handlebars";

export async function getPrompt(
  key: string,
  scope: "SYSTEM" | "ORG" | "USER",
  context: PromptContext,
): Promise<string> {
  // Get prompt with fallback chain: USER -> ORG -> SYSTEM
  const prompt = await db.prompt.findFirst({
    where: {
      key,
      scope,
      userId: scope === "USER" ? context.userId : undefined,
      organizationId: scope === "ORG" ? context.organizationId : undefined,
    },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  if (!prompt?.versions[0]) {
    throw new Error(`Prompt not found: ${key}`);
  }

  // Render with variables
  const template = Handlebars.compile(prompt.versions[0].content);
  return template(context.variables);
}

// Usage in agent
const systemPrompt = await getPrompt("document-generator:system", "SYSTEM", {
  variables: {
    documentType: "PRD",
    projectName: project.name,
  },
});
```

### Agent Task Tracking

**✅ DO**: Track agent task execution

```typescript
// packages/api/modules/agents/procedures/start-task.ts
export const startAgentTaskProcedure = protectedProcedure
  .input(z.object({
    agentId: z.string(),
    input: z.record(z.unknown()),
    documentType: z.string().optional(),
  }))
  .handler(async ({ input, context }) => {
    // Create task record
    const task = await db.agentTask.create({
      data: {
        agentId: input.agentId,
        userId: context.user.id,
        organizationId: context.session.activeOrganizationId,
        status: "PENDING",
        stage: "INIT",
        input: input.input,
        framework: "LANGGRAPH",
      },
    });

    // Start Temporal workflow for durability
    const client = await getTemporalClient();
    const handle = await client.workflow.start(agentTaskWorkflow, {
      taskQueue: "agent-tasks",
      workflowId: `agent-task-${task.id}`,
      args: [{
        taskId: task.id,
        agentId: input.agentId,
        input: input.input,
      }],
    });

    // Update task with workflow reference
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: "RUNNING",
      },
    });

    return { taskId: task.id, workflowId: handle.workflowId };
  });
```

## ❌ DON'T

### Direct LLM Calls in Components

**❌ DON'T**: Call LLMs directly from React components

```tsx
// Bad: LLM call in component
export function DocumentGenerator() {
  const [doc, setDoc] = useState("");
  
  const generate = async () => {
    // ❌ Direct API call, no streaming, no error handling
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });
    setDoc(response.choices[0].message.content);
  };
}
```
**Why**: No streaming, error handling, or observability. Blocks UI.

**✅ Better**:

```tsx
// Good: Use agent procedure with streaming
export function DocumentGenerator() {
  const streamMutation = useMutation({
    mutationFn: async (input: GenerateInput) => {
      const response = await api.agents.generate(input);
      
      for await (const event of response) {
        if (event.type === "text_delta") {
          setDoc(prev => prev + event.delta);
        }
      }
    },
  });
}
```

### Hardcoded Prompts

**❌ DON'T**: Hardcode prompts in agent code

```typescript
// Bad: Hardcoded prompts
const SYSTEM_PROMPT = `You are a helpful assistant that generates documents.
Always be professional and thorough.`;

async function generateDocument(input: string) {
  return await model.generate({
    system: SYSTEM_PROMPT,  // ❌ Can't be customized
    user: input,
  });
}
```
**Why**: No customization, versioning, or A/B testing.

**✅ Better**:

```typescript
// Good: Use prompt library
async function generateDocument(input: string, context: PromptContext) {
  const systemPrompt = await getPrompt("doc-generator:system", "SYSTEM", context);
  
  return await model.generate({
    system: systemPrompt,
    user: input,
  });
}
```

### Unbounded Context

**❌ DON'T**: Send unlimited context to LLMs

```typescript
// Bad: Entire project as context
async function generateWithContext(project: Project) {
  const allDocs = await db.document.findMany({ where: { projectId: project.id } });
  
  return await model.generate({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: allDocs.map(d => d.content).join("\n") },  // ❌ Could be MB of text
    ],
  });
}
```
**Why**: Token limits, cost, and performance issues.

**✅ Better**:

```typescript
// Good: RAG with relevant context only
async function generateWithContext(project: Project, query: string) {
  // Retrieve only relevant chunks
  const relevantChunks = await ragService.search({
    query,
    projectId: project.id,
    limit: 10,
  });

  const context = relevantChunks.map(c => c.content).join("\n\n");

  return await model.generate({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Context:\n${context}\n\nQuery: ${query}` },
    ],
  });
}
```

## Patterns & Examples

### Pattern 1: Multi-Agent Orchestration

**Use Case**: Complex tasks requiring multiple specialized agents

```typescript
export async function orchestrateDocumentGeneration(
  input: DocumentInput,
): Promise<Document> {
  // 1. Research agent gathers information
  const research = await runAgent("research-agent", {
    topic: input.topic,
    sources: input.sources,
  });

  // 2. Outline agent creates structure
  const outline = await runAgent("outline-agent", {
    topic: input.topic,
    research: research.findings,
  });

  // 3. Writer agent generates content (parallel for sections)
  const sections = await Promise.all(
    outline.sections.map(section =>
      runAgent("writer-agent", {
        section,
        style: input.style,
        research: research.findings,
      }),
    ),
  );

  // 4. Editor agent reviews and refines
  const finalDoc = await runAgent("editor-agent", {
    sections,
    style: input.style,
  });

  return finalDoc;
}
```

### Pattern 2: Tool Integration

**Use Case**: Agent with external tool capabilities

```typescript
const tools = [
  {
    name: "search_codebase",
    description: "Search the project codebase for relevant code",
    parameters: z.object({
      query: z.string(),
      fileTypes: z.array(z.string()).optional(),
    }),
    execute: async (params) => {
      return await codebaseSearch(params.query, params.fileTypes);
    },
  },
  {
    name: "read_file",
    description: "Read contents of a file",
    parameters: z.object({
      path: z.string(),
    }),
    execute: async (params) => {
      return await readProjectFile(params.path);
    },
  },
  {
    name: "create_ticket",
    description: "Create a ticket in Linear",
    parameters: z.object({
      title: z.string(),
      description: z.string(),
      priority: z.enum(["low", "medium", "high"]).optional(),
    }),
    execute: async (params) => {
      return await linearClient.createIssue(params);
    },
    requiresApproval: true,  // Human approval required
  },
];
```

### Pattern 3: Streaming with CopilotKit

**Use Case**: UI-integrated agent with real-time updates

```tsx
// modules/saas/agents/components/AgentChatCopilotKit.tsx
"use client";

import { CopilotKit, useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";

export function AgentChat({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);

  // Provide context to the agent
  useCopilotReadable({
    description: "Current project details",
    value: project,
  });

  // Define available actions
  useCopilotAction({
    name: "generateDocument",
    description: "Generate a project document",
    parameters: [
      { name: "type", type: "string", description: "Document type (PRD, spec, etc.)" },
      { name: "title", type: "string", description: "Document title" },
    ],
    handler: async ({ type, title }) => {
      const result = await api.agents.generateDocument({
        projectId,
        type,
        title,
      });
      return result.document;
    },
  });

  return (
    <CopilotKit url="/api/copilot">
      <CopilotChat
        labels={{
          title: "Project Assistant",
          initial: "How can I help with your project?",
        }}
      />
    </CopilotKit>
  );
}
```

## Error Handling

```typescript
export class AgentError extends Error {
  constructor(
    message: string,
    public code: AgentErrorCode,
    public recoverable: boolean = false,
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export enum AgentErrorCode {
  RATE_LIMIT = "RATE_LIMIT",
  CONTEXT_TOO_LONG = "CONTEXT_TOO_LONG",
  TOOL_FAILED = "TOOL_FAILED",
  APPROVAL_TIMEOUT = "APPROVAL_TIMEOUT",
  INVALID_OUTPUT = "INVALID_OUTPUT",
}

// Retry logic
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (error instanceof AgentError && !error.recoverable) {
        throw error;
      }
      
      await sleep(options.backoff * Math.pow(2, attempt));
    }
  }
  
  throw lastError!;
}
```

## Resources

- [AG-UI Protocol](https://github.com/ag-ui/protocol)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)
- [CopilotKit Documentation](https://docs.copilotkit.ai)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)


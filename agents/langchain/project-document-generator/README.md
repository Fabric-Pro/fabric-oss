# Project Document Generator Agent

LangGraph agent for project-based document generation with RAG context and predictive state updates.

## Overview

This agent provides:
- **RAG Integration**: Retrieves relevant project contexts from Qdrant
- **Predictive State Updates**: Real-time streaming of document changes as they're generated
- **Project Context Awareness**: Incorporates project details (tech stack, features, goals) into generation
- **Document Type Support**: Generates PRDs, Architecture docs, Technical Specs, API Specs, User Stories, and more
- **CopilotKit Integration**: Seamless integration with CopilotKit for UI updates

## Quick Start

### 1. Install Dependencies
```bash
cd agents/langchain/project-document-generator
pnpm install
```

### 2. Configure Environment
Create a `.env` file with your API keys:
```bash
# Required: At least one LLM API key
OPENAI_API_KEY="sk-..."
# or
ANTHROPIC_API_KEY="sk-ant-..."

# Optional: AI Gateway
AI_GATEWAY_API_KEY="vck_..."

# Optional: LangSmith tracing
LANGSMITH_API_KEY="lsv2_pt_..."
```

### 3. Start the Server

**Option A: Docker (Recommended for Production)**
```bash
./start-langgraph.sh
```

**Option B: Development Mode (Hot Reload)**
```bash
pnpm dev
```

### 4. Verify Server is Running
```bash
curl http://localhost:8125/ok
```

Visit API docs: http://localhost:8125/docs

---

## Architecture

### Graph Structure
The agent uses a LangGraph workflow with predictive state updates:

```typescript
State → Generate → Update → Confirm → Final State
         ↓
    Predictive Updates (streaming)
```

### State Schema
```typescript
{
  messages: Array<BaseMessage>;
  document: string;
  documentType: ProjectDocumentType;
  projectContext: {
    name: string;
    description?: string;
    goals?: string;
    techStack: string[];
    features: string[];
    projectType?: string;
  };
  ragContexts: string[];
  tools: any[];
  retryCount: number;
  error?: string;
}
```

### Predictive Updates
The agent streams incremental updates as the document is generated:
- Each update includes the full document state
- Diffs are calculated on the client side
- Updates are sent via Server-Sent Events (SSE)

---

## Integration with Fabric

### Backend Integration (Temporal Workflow)
```typescript
// packages/temporal/src/workflows/project-document-generation.ts
const handle = await client.workflow.start("projectDocumentGenerationWorkflow", {
  taskQueue: "default",
  workflowId: `project-document-generation-${documentId}-${Date.now()}`,
  args: [{
    projectId,
    documentId,
    documentType,
    userId,
    prompt,
  }],
});
```

### Frontend Integration (CopilotKit)
```typescript
import { useCopilotAction } from "@copilotkit/react-core";

// In your component
useCopilotAction({
  name: "generate_project_document",
  parameters: [
    { name: "prompt", type: "string", description: "Document generation prompt" }
  ],
  handler: async ({ prompt }) => {
    // Calls the LangGraph agent at localhost:8125
    // Receives predictive state updates via SSE
  }
});
```

---

## Document Types

- **GENERAL**: Free-form document
- **PRD**: Product Requirements Document
- **PROPOSAL**: Project Proposal
- **ARCHITECTURE**: Architecture Document
- **TECHNICAL_SPEC**: Technical Specification
- **USER_STORY**: User Stories
- **API_SPEC**: API Specification

---

## Development

### Run in Development Mode
```bash
pnpm dev
```

### Build
```bash
pnpm build
```

### Stop Docker Services
```bash
./stop-langgraph.sh
```

---

## Environment Variables

- `OPENAI_API_KEY`: OpenAI API key
- `ANTHROPIC_API_KEY`: Anthropic API key
- `AI_GATEWAY_API_KEY`: Vercel AI Gateway API key (optional)
- `LANGSMITH_API_KEY`: LangSmith tracing API key (optional)
- `PROJECT_DOCUMENT_GENERATOR_URL`: Agent URL (default: http://localhost:8125)

---

## Troubleshooting

### Agent not starting
- Check if port 8125 is available
- Verify API keys are set in `.env`
- Check Docker logs: `docker-compose logs -f`

### No predictive updates
- Ensure `predict_state` metadata is configured in agent.ts
- Check CopilotKit integration in frontend
- Verify WebSocket connection

### RAG context not working
- Verify Qdrant is running and accessible
- Check project contexts are stored in Qdrant
- Verify tenant isolation (userId/organizationId)

---

## License

MIT


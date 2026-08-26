# Document Generator Agent

LangGraph agent for document generation with predictive state updates and real-time streaming.

## Overview

This agent provides:
- **Predictive State Updates**: Real-time streaming of document changes as they're generated
- **Diff Highlighting**: Incremental updates with visual diff markers
- **CopilotKit Integration**: Seamless integration with CopilotKit for UI updates

## Quick Start

### 1. Install Dependencies
```bash
cd agents/langchain/document-generator
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
curl http://localhost:8124/ok
```

Visit API docs: http://localhost:8124/docs

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
  status: "idle" | "generating" | "complete";
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

### Frontend Integration (CopilotKit)
```typescript
import { useCopilotAction } from "@copilotkit/react-core";

// In your component
useCopilotAction({
  name: "generate_document",
  parameters: [
    { name: "prompt", type: "string", description: "Document prompt" }
  ],
  handler: async ({ prompt }) => {
    // Calls the LangGraph agent at localhost:8124
    // Receives predictive state updates via SSE
  }
});
```

### Backend Integration (API)
```typescript
// packages/api/modules/agents/document-generator.ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: "http://localhost:8124"
});

const stream = client.runs.stream(
  "default",
  "document_generator",
  { input: { messages: [...] } }
);

for await (const chunk of stream) {
  // Handle predictive updates
}
```

---

## Development

### File Structure
```
document-generator/
├── agent.ts              # Agent graph definition
├── server.ts             # LangGraph server entry point
├── langgraph.json        # LangGraph configuration
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
├── Dockerfile            # Docker image
├── docker-compose.yml    # Docker services
├── .env                  # Environment variables
├── start-langgraph.sh    # Start script
├── stop-langgraph.sh     # Stop script
└── MANAGING_SERVER.md    # Server management guide
```

### Making Changes

1. **Edit the agent logic**: Modify `agent.ts`
2. **Rebuild and restart**:
   ```bash
   docker-compose up -d --build
   ```
3. **View logs**:
   ```bash
   docker-compose logs -f langgraph-api
   ```

### Testing

Test the agent directly via API:
```bash
curl -X POST http://localhost:8124/runs/stream \
  -H "Content-Type: application/json" \
  -d '{
    "assistant_id": "document_generator",
    "input": {
      "messages": [
        {"role": "user", "content": "Generate a product requirements document"}
      ]
    },
    "stream_mode": "updates"
  }'
```

---

## Deployment

### Docker Deployment
The agent runs in a Docker container with:
- **LangGraph API Server**: Port 8124
- **Redis**: For state persistence
- **PostgreSQL**: Connected to main Fabric database

### Environment Variables
Required in production:
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
- `REDIS_URI`: Redis connection string
- `POSTGRES_URI`: PostgreSQL connection string

Optional:
- `AI_GATEWAY_API_KEY`: For Vercel AI Gateway
- `LANGSMITH_API_KEY`: For LangSmith tracing

---

## Troubleshooting

### "In-mem server for JS graphs is not supported"
**Solution**: Use `npx @langchain/langgraph-cli@latest dev` instead of `langgraph dev`

This is already configured in `package.json`:
```json
"scripts": {
  "dev": "npx @langchain/langgraph-cli@latest dev --host localhost --port 8124"
}
```

### Port 8124 Already in Use
```bash
# Find and kill the process
lsof -i :8124
kill -9 <PID>

# Or stop Docker
docker-compose down
```

### Agent Not Streaming Updates
Check that:
1. The graph is registered: `docker-compose logs | grep "document_generator"`
2. The client is using `stream_mode: "updates"`
3. The frontend is handling SSE events correctly

---

## Resources

- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)
- [CopilotKit Documentation](https://docs.copilotkit.ai/)
- [Predictive State Updates Guide](../../docs/document_generator_ANALYSIS.md)
- [Server Management Guide](./MANAGING_SERVER.md)

---

## Support

For issues or questions:
1. Check the logs: `docker-compose logs -f`
2. Review the [MANAGING_SERVER.md](./MANAGING_SERVER.md) guide
3. Check the main Fabric documentation in `/docs`


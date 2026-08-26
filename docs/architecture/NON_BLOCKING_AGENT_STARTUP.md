# Non-Blocking Agent Startup Architecture

## Overview

The Fabric Portal web application is designed to start immediately without waiting for agent services to be ready. This architecture enables fast development iteration times while maintaining robust runtime integration with LangGraph agents.

## Architecture Principles

### 1. Parallel Service Startup

All services start in parallel via Aspire orchestration:
- **Infrastructure**: PostgreSQL, Redis, Qdrant, Temporal, MinIO
- **Observability**: Prometheus, Grafana, Jaeger
- **Agents**: document-generator, project-document-generator, prompt-enhancer
- **Applications**: web, temporal-worker

The web application only waits for critical infrastructure (database, cache) but **not** for agents.

### 2. Lazy Agent Registration

Agents are registered at **request time**, not at startup:

```typescript
// apps/web/app/api/copilotkit/route.ts
export async function POST(req: NextRequest) {
  // Initialize agent registry on each request
  const registry = new AgentRegistry();
  
  // Register agents with deployment URLs
  registry.register(new LangGraphAgentAdapter({
    name: "document_generator",
    deploymentUrl: process.env.DOCUMENT_GENERATOR_URL || "http://localhost:8124",
    // ... configuration
  }));
}
```

**Key Points:**
- No blocking operations during adapter construction
- Deployment URLs are stored, not validated
- Actual agent initialization happens lazily when needed

### 3. Lazy Agent Initialization

The `LangGraphAgentAdapter` defers initialization until first use:

```typescript
// packages/agent-core/src/adapters/langgraph-adapter.ts
private initializeLangGraphAgent(): void {
  if (this.langGraphAgent) {
    return; // Already initialized
  }
  
  // Dynamically import and initialize only when needed
  const { LangGraphAgent } = require("@copilotkit/runtime");
  this.langGraphAgent = new LangGraphAgent({
    deploymentUrl: this.deploymentUrl,
    graphId: this.graphId,
  });
}

getCopilotKitAgent(): any {
  this.initializeLangGraphAgent(); // Lazy initialization
  return this.langGraphAgent;
}
```

### 4. Graceful Degradation

When agents are not available, the system handles failures gracefully:

#### Health Check Failures
```typescript
async healthCheck(): Promise<AgentHealthStatus> {
  try {
    const response = await fetch(`${this.deploymentUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    
    return {
      healthy: response.ok,
      responseTime: Date.now() - startTime,
      lastCheck: new Date(),
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      lastCheck: new Date(),
    };
  }
}
```

#### UI Error Handling
- Loading states while agents initialize
- Error messages when agents are unavailable
- Retry mechanisms for transient failures
- Health check UI to monitor agent status

## Aspire Configuration

### Before (Blocking)
```csharp
var web = builder.AddNpmApp("web", "../../apps/web", "dev")
    .WithReference(fabricDb)
    .WithReference(redis)
    .WaitFor(fabricDb)
    .WaitFor(redis)
    .WaitFor(documentGenerator)      // ❌ Blocks startup
    .WaitFor(projectDocumentGenerator) // ❌ Blocks startup
    .WaitFor(promptEnhancer);         // ❌ Blocks startup
```

### After (Non-Blocking)
```csharp
var web = builder.AddNpmApp("web", "../../apps/web", "dev")
    .WithReference(fabricDb)
    .WithReference(redis)
    .WaitFor(fabricDb)
    .WaitFor(redis)
    // Agents start in parallel, web app doesn't wait
    .WithExternalHttpEndpoints();
```

## Development Workflow

### Fast Startup
```bash
./aspire.sh restart
```

**Timeline:**
1. **0-2s**: Infrastructure services start (PostgreSQL, Redis)
2. **2-3s**: Web app starts (no longer blocked by agents)
3. **3-30s**: Agents start in parallel (install deps, compile, start server)

**Result:** Web app is accessible at http://localhost:3001 within 3 seconds, even if agents take 30+ seconds to start.

### Agent Availability

Agents become available asynchronously:
- **Immediate**: Web app UI loads, authentication works
- **When agents ready**: Document generation features become available
- **If agents fail**: Error messages guide users to check agent status

## Runtime Behavior

### Request Flow

1. **User triggers agent feature** (e.g., document generation)
2. **CopilotKit endpoint called** (`/api/copilotkit`)
3. **Agent registry initialized** (lazy, per-request)
4. **Agent adapter created** (no blocking operations)
5. **Agent invoked** (via LangGraph client)
6. **Health check performed** (if agent unavailable, error returned)

### Error Scenarios

#### Agent Not Started Yet
```json
{
  "error": "Agent health check failed",
  "code": "AGENT_UNAVAILABLE",
  "message": "document_generator is not healthy: Connection refused"
}
```

**User Experience:**
- Loading spinner while waiting
- Error message: "Agent is starting, please try again in a moment"
- Retry button

#### Agent Crashed
```json
{
  "error": "Agent health check failed",
  "code": "AGENT_UNHEALTHY",
  "message": "document_generator returned status 500"
}
```

**User Experience:**
- Error message: "Agent encountered an error"
- Link to Aspire Dashboard for logs
- Contact support option

## Monitoring

### Aspire Dashboard
- **URL**: https://localhost:17134
- **Features**:
  - Real-time service status
  - Health check results
  - Logs from all services
  - Distributed tracing

### Health Check Endpoints
- **Web App**: http://localhost:3001/health
- **Document Generator**: http://localhost:8124/ok
- **Project Document Generator**: http://localhost:8125/ok
- **Prompt Enhancer**: http://localhost:8134/ok

## Best Practices

### For Developers

1. **Don't assume agents are ready**: Always handle agent unavailability
2. **Use health checks**: Check agent status before critical operations
3. **Provide feedback**: Show loading states and error messages
4. **Enable retries**: Allow users to retry failed operations

### For Agent Developers

1. **Fast startup**: Minimize agent initialization time
2. **Health endpoints**: Implement `/health` and `/ok` endpoints
3. **Graceful shutdown**: Handle SIGTERM for clean restarts
4. **Error reporting**: Return meaningful error messages

## Future Enhancements

1. **Agent readiness notifications**: WebSocket notifications when agents become ready
2. **Automatic retries**: Retry failed agent calls with exponential backoff
3. **Circuit breakers**: Prevent cascading failures when agents are down
4. **Agent pooling**: Multiple agent instances for high availability


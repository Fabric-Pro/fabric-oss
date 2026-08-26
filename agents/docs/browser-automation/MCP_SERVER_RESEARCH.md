# Browser Automation MCP Server - Research Document

> **Version**: 2.1
> **Date**: December 16, 2024
> **Status**: Research Complete - MCP Spec Compliant
> **MCP Spec Version**: 2025-03-26

## Executive Summary

This document analyzes CUGA's (ConfigUrable Generalist Agent) MCP server implementation and compares it with fabric-portal's existing browser automation capabilities. **The updated recommendation is to expose fabric-portal's existing workflows as an MCP server** rather than integrating CUGA's external MCP server, as fabric-portal already implements more comprehensive features.

### Key Finding

Fabric-portal already has **more capabilities** than CUGA's MCP server:

| Capability | CUGA MCP | Fabric-Portal | Advantage |
|------------|----------|---------------|-----------|
| Execution Modes | 3 (api, web, hybrid) | **5** (api-first, browser-first, api-only, browser-only, parallel) | Fabric |
| Template System | ❌ | ✅ Save & reuse with parameters | Fabric |
| RAG Integration | ❌ | ✅ Web content extraction | Fabric |
| Multi-Tenancy | ❌ | ✅ userId + organizationId | Fabric |
| Durability | Basic | ✅ Temporal workflows | Fabric |

## 1. CUGA's MCP Server Implementation

### Overview

CUGA can be exposed as an MCP (Model Context Protocol) server, enabling other AI applications to leverage its browser automation and API execution capabilities. The implementation uses **FastMCP** to create an SSE-based server.

### Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   MCP Client    │───▶│   CUGA MCP       │───▶│   CUGA Agent    │
│  (Claude, etc.) │    │   Server         │    │   (Core)        │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │                          │
                              ▼                          ▼
                       ┌──────────────┐         ┌─────────────────┐
                       │ Environment  │         │ Browser/API     │
                       │ Variables    │         │ Execution       │
                       └──────────────┘         └─────────────────┘
```

### Key Implementation Details

- **Transport**: SSE (Server-Sent Events) on `http://localhost:8000/sse`
- **Framework**: FastMCP (Python)
- **Configuration**: YAML-based MCP servers configuration
- **Execution Modes**: API, Web, and Hybrid modes

## 2. MCP Tools Provided by CUGA

CUGA exposes three primary tools through its MCP server:

### Tool 1: `run_api_task`

**Purpose**: Execute tasks using API-only mode (headless, no GUI)

```python
@mcp.tool
async def run_api_task(task: str) -> str:
    """
    Run a task using API mode only - headless browser automation without GUI interaction
    Args:
        task: The task description to execute
    Returns:
        str: The result of the task execution
    """
```

**Schema**:
```json
{
  "name": "run_api_task",
  "description": "Run a task using API mode only - headless browser automation without GUI interaction",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The task description to execute"
      }
    },
    "required": ["task"]
  }
}
```

**Example Tasks**:
- "Get my top account by revenue from digital sales"
- "List all accounts with revenue above $100k"
- "Retrieve customer data from CRM API"

### Tool 2: `run_web_task`

**Purpose**: Execute tasks using browser automation with GUI interaction

```python
@mcp.tool
async def run_web_task(task: str, start_url: str) -> str:
    """
    Run a task using web mode only - browser automation with GUI interaction
    Args:
        task: The task description to execute
        start_url: The starting URL for the task
    Returns:
        str: The result of the task execution
    """
```

**Schema**:
```json
{
  "name": "run_web_task",
  "description": "Run a task using web mode only - browser automation with GUI interaction",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The task description to execute"
      },
      "start_url": {
        "type": "string",
        "description": "The starting URL for the task"
      }
    },
    "required": ["task", "start_url"]
  }
}
```

**Example Tasks**:
- "Navigate to dashboard and download report"
- "Fill out contact form on website"
- "Extract data from web tables"

### Tool 3: `run_hybrid_task`

**Purpose**: Execute tasks using combined API and web interaction

```python
@mcp.tool
async def run_hybrid_task(task: str, start_url: str) -> str:
    """
    Run a task using hybrid mode - combination of API and web interaction
    Args:
        task: The task description to execute
        start_url: The starting URL for the task
    Returns:
        str: The result of the task execution
    """
```

**Schema**:
```json
{
  "name": "run_hybrid_task",
  "description": "Run a task using hybrid mode - combination of API and web interaction",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The task description to execute"
      },
      "start_url": {
        "type": "string",
        "description": "The starting URL for the task"
      }
    },
    "required": ["task", "start_url"]
  }
}
```

**Example Tasks**:
- "Get API data and cross-reference with web dashboard"
- "Validate API results against web interface"
- "Sync data between web form and API endpoint"

## 3. CUGA's Tool Integration Architecture

CUGA supports three types of tool integrations:

| Tool Type | Best For | Configuration | Runtime Loading |
|-----------|----------|---------------|-----------------|
| **OpenAPI** | REST APIs, existing services | `mcp_servers.yaml` | ✅ Build |
| **MCP** | Custom protocols, complex integrations | `mcp_servers.yaml` | ✅ Build |
| **LangChain** | Python functions, rapid prototyping | Direct import | ✅ Runtime |

### Configuration Example

```yaml
# mcp_servers.yaml
services:
  - digital_sales:
      url: "https://digitalsales.example.com/openapi.json"
      description: "Digital Sales API"
      include: ["getMyAccounts", "getAccountsTpp"]

mcpServers:
  customer_tools:
    url: "http://127.0.0.1:8000/sse"
    description: "Customer relationship management tools"

  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
```

## 4. Fabric-Portal vs CUGA: Feature Comparison

Before deciding on integration approach, let's compare what fabric-portal already has:

### Existing Fabric-Portal Workflows

| Workflow | File Location | Capabilities |
|----------|---------------|--------------|
| `browserAutomationWorkflow` | `packages/temporal/src/workflows/browser-automation.ts` | Full Playwright automation, session management, actions, extraction |
| `hybridExecutionWorkflow` | `packages/temporal/src/workflows/hybrid-execution.ts` | **5 modes**: api-first, browser-first, api-only, browser-only, parallel |
| `templateExecutionWorkflow` | `packages/temporal/src/workflows/template-execution.ts` | Save/reuse templates with `{{param}}` placeholders, versioning |
| `browserRagIngestionWorkflow` | `packages/temporal/src/workflows/browser-rag-ingestion.ts` | Extract web content for RAG/vector search |

### Detailed Comparison: CUGA MCP Tools vs Fabric Workflows

| CUGA MCP Tool | Fabric Equivalent | Fabric Advantages |
|---------------|-------------------|-------------------|
| `run_api_task` | `hybridExecutionWorkflow` with `mode: "api-only"` | ✅ Part of unified hybrid system |
| `run_web_task` | `browserAutomationWorkflow` | ✅ More action types, session management |
| `run_hybrid_task` | `hybridExecutionWorkflow` | ✅ **5 modes** vs CUGA's 1, fallback config |
| ❌ Not available | `templateExecutionWorkflow` | ✅ Reusable automation templates |
| ❌ Not available | `browserRagIngestionWorkflow` | ✅ RAG content extraction |

### Hybrid Execution Modes (Fabric has 5, CUGA has 1)

```typescript
// Fabric's hybridExecutionWorkflow supports:
type HybridMode =
  | "api-first"      // Try API, fallback to browser
  | "browser-first"  // Try browser, fallback to API
  | "api-only"       // API only (equivalent to CUGA's run_api_task)
  | "browser-only"   // Browser only
  | "parallel";      // Race condition - first success wins
```

### Multi-Tenancy (Fabric built-in, CUGA requires setup)

```typescript
// All fabric workflows already support multi-tenancy:
interface HybridExecutionInput {
  taskId: string;
  userId: string;           // ✅ User scoping
  organizationId?: string;  // ✅ Organization scoping
  mode: HybridMode;
  steps: HybridStep[];
  // ...
}
```

## 5. Option Comparison: Add CUGA vs Expose Fabric

### Option A: Add CUGA as External MCP Server (NOT Recommended)

Run CUGA's Python MCP server alongside fabric-portal.

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   MCP Client    │───▶│   CUGA MCP       │───▶│   CUGA Agent    │
│  (Claude, etc.) │    │   Server (Py)    │    │   (Python)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              ×                          ×
                       ┌──────────────┐         ┌─────────────────┐
                       │ Separate     │         │ Duplicate       │
                       │ Auth System  │         │ Browser Logic   │
                       └──────────────┘         └─────────────────┘
```

**Cons**:
- ❌ Duplicates existing fabric functionality
- ❌ Requires Python runtime alongside TypeScript
- ❌ Separate authentication system to maintain
- ❌ No access to fabric's templates or RAG
- ❌ Less features than fabric already has
- ❌ Additional deployment complexity

### Option B: Expose Fabric Workflows as MCP Server (RECOMMENDED)

Create an MCP server endpoint that wraps fabric-portal's existing Temporal workflows.

```
┌─────────────────┐    ┌──────────────────────────────────────────┐
│   MCP Client    │───▶│           Fabric Portal API              │
│ (Claude Desktop,│    │  ┌────────────┐    ┌─────────────────┐   │
│  Other Agents)  │    │  │ MCP Route  │───▶│ Temporal        │   │
└─────────────────┘    │  │ /api/mcp   │    │ Workflows       │   │
                       │  └────────────┘    └─────────────────┘   │
                       │         │                   │             │
                       │         ▼                   ▼             │
                       │  ┌────────────┐    ┌─────────────────┐   │
                       │  │ Better Auth│    │ browserAutomation│   │
                       │  │ Session    │    │ hybridExecution  │   │
                       │  └────────────┘    │ templateExecution│   │
                       │                    │ browserRagIngest │   │
                       │                    └─────────────────┘   │
                       └──────────────────────────────────────────┘
```

**Pros**:
- ✅ **More features** than CUGA (5 hybrid modes, templates, RAG)
- ✅ Reuses existing authentication (Better Auth)
- ✅ Leverages existing multi-tenancy
- ✅ Single deployment unit (TypeScript only)
- ✅ Temporal durability built-in
- ✅ No duplicate code or systems
- ✅ Consistent with fabric-portal architecture

## 6. Updated Recommendation

### Recommendation: **Option B - Expose Fabric Workflows as MCP Server**

**Rationale**:
1. **Feature Superiority**: Fabric already has MORE features than CUGA's MCP server
2. **No Duplication**: Don't rebuild what already exists
3. **Multi-tenancy**: Already built into all workflows
4. **Durability**: Temporal workflows provide better durability than CUGA
5. **Single Stack**: Keep TypeScript-only, no Python dependency
6. **Template System**: Expose fabric's unique template capability via MCP

### Proposed MCP Tools for Fabric-Portal

Expose these 5 tools (vs CUGA's 3):

| MCP Tool | Description | Maps To | CUGA Equivalent |
|----------|-------------|---------|-----------------|
| `run_browser_task` | Execute browser automation | `browserAutomationWorkflow` | `run_web_task` |
| `run_hybrid_task` | Execute hybrid API+browser with 5 modes | `hybridExecutionWorkflow` | `run_hybrid_task` (enhanced) |
| `run_api_task` | Execute API-only task | `hybridExecutionWorkflow` with `mode: "api-only"` | `run_api_task` |
| `execute_template` | Execute saved automation template | `templateExecutionWorkflow` | ❌ Not in CUGA |
| `extract_web_content` | Extract content from URL for RAG | `browserRagIngestionWorkflow` | ❌ Not in CUGA |

## 7. High-Level Implementation Plan

### Phase 1: MCP Server Package & Foundation (Week 1)

1. **Create MCP Server Package**
   - New package: `packages/mcp-server` (`@fabricorg/mcp-server`)
   - Add `@modelcontextprotocol/sdk` server components
   - Configure **stdio** transport for local development (npx)
   - CLI entry point: `bin/cli.ts`

2. **Create Remote MCP Endpoint**
   - Route: `POST /api/mcp` - Streamable HTTP for remote clients
   - Authentication via Better Auth session or API key
   - Extract userId/organizationId from auth context

3. **Implement Core Browser Tools**
   - `run_browser_task`: Wraps `browserAutomationWorkflow`
   - `run_api_task`: Wraps `hybridExecutionWorkflow` with `mode: "api-only"`

### Phase 2: Hybrid & Template Tools (Week 2)

4. **Add Hybrid Execution Tool**
   - `run_hybrid_task`: Wraps `hybridExecutionWorkflow`
   - Expose all 5 execution modes via tool parameters
   - Document fallback configuration options

5. **Add Template Tool**
   - `execute_template`: Wraps `templateExecutionWorkflow`
   - List available templates for the user/org
   - Parameter validation and resolution with `{{param}}` syntax

### Phase 3: RAG & Advanced Tools (Week 3)

6. **Add RAG Extraction Tool**
   - `extract_web_content`: Wraps `browserRagIngestionWorkflow`
   - Returns extracted content in structured format
   - Supports multiple output formats (text, markdown, JSON)

7. **Add Helper Tools**
   - `list_templates`: Return available automation templates
   - `get_template_schema`: Return parameter schema for a template

### Phase 4: Security & Multi-Tenancy (Week 3-4)

8. **Tenant Scoping**
   - stdio: Extract userId/organizationId from environment variables
   - HTTP: Extract from Better Auth session or API key header
   - Pass to all workflow inputs automatically
   - Validate template access permissions

9. **Security Hardening**
   - URL allowlist/denylist configuration
   - Rate limiting per tenant (HTTP endpoint)
   - Audit logging for all MCP tool calls
   - Input sanitization for browser actions
   - CORS configuration for remote HTTP access

### Phase 5: Testing & Documentation (Week 4)

10. **Testing**
    - Unit tests for MCP tool handlers
    - Integration tests with Temporal workflows
    - E2E tests with MCP Inspector
    - E2E tests with Claude Desktop (stdio via npx)
    - Load testing for remote HTTP endpoint

11. **Documentation**
    - Claude Desktop setup guide (stdio via npx)
    - Remote MCP server setup guide (Streamable HTTP)
    - Tool reference with input/output schemas
    - Security best practices
    - Troubleshooting guide

12. **Publish Package**
    - Publish `@fabricorg/mcp-server` to npm
    - Add to monorepo workspace

## 8. Technical Considerations

### Transport Options

The MCP server should support **both** transport mechanisms:

| Transport | Use Case | Invocation | Best For |
|-----------|----------|------------|----------|
| **Streamable HTTP** | Remote/Production | `POST /api/mcp` | Cloud deployments, stateless, scalable |
| **stdio** | Local/Development | `npx @fabricorg/mcp-server` | Claude Desktop local, subprocess communication |

### Streamable HTTP Transport (Recommended for Remote MCP)

Streamable HTTP is the **recommended transport for remote MCP servers** as it:
- Works with standard HTTP infrastructure (load balancers, proxies)
- Supports stateless deployments
- Better suited for cloud/serverless environments
- Uses standard request/response with optional streaming

#### MCP Spec Compliance (2025-03-26)

Per the [MCP Transports Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports):

| Requirement | Implementation |
|-------------|----------------|
| Single endpoint for POST/GET | `POST /api/mcp` for requests, `GET /api/mcp` for server-initiated SSE |
| Accept header validation | Must accept `application/json` and `text/event-stream` |
| Mcp-Session-Id header | Required for stateful sessions (optional for stateless) |
| 202 Accepted for notifications | Return 202 with no body for notification-only requests |
| DELETE for session termination | `DELETE /api/mcp` to end session |
| Origin header validation | **MUST** validate to prevent DNS rebinding attacks |

#### Stateless vs Stateful Implementation

**For fabric-portal, we use a stateless approach** because:
1. Each tool call triggers an independent Temporal workflow
2. Temporal provides durability and state management
3. No conversation state needed in the MCP layer
4. User context comes from authentication, not session

```typescript
// Streamable HTTP route in Next.js (apps/web/app/api/mcp/route.ts)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { auth } from "@repo/auth";

// Session store for stateful mode (optional)
const sessions = new Map<string, McpServer>();

export async function POST(request: Request) {
  // Security: Validate Origin header to prevent DNS rebinding
  const origin = request.headers.get("origin");
  if (origin && !isAllowedOrigin(origin)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Authenticate request
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Check for existing MCP session
  const mcpSessionId = request.headers.get("mcp-session-id");
  let mcpServer: McpServer;

  if (mcpSessionId && sessions.has(mcpSessionId)) {
    // Reuse existing session
    mcpServer = sessions.get(mcpSessionId)!;
  } else {
    // Create new MCP server instance
    mcpServer = new McpServer({
      name: "fabric-browser-automation",
      version: "1.0.0",
    });

    // Register tools with user context
    registerBrowserTools(mcpServer, {
      userId: session.user.id,
      organizationId: session.session.activeOrganizationId,
    });
  }

  // Create transport for this request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const newSessionId = `mcp-${session.user.id}-${Date.now()}`;
      sessions.set(newSessionId, mcpServer);
      return newSessionId;
    },
  });

  await mcpServer.connect(transport);

  // Handle the request per MCP spec
  const body = await request.json();

  // Check Accept header
  const accept = request.headers.get("accept") || "";
  const wantsSSE = accept.includes("text/event-stream");

  try {
    const response = await transport.handleRequest(body, {
      // Signal if client wants SSE streaming
      preferStreaming: wantsSSE,
    });

    // Return appropriate content type
    if (response.isStream) {
      return new Response(response.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...(response.sessionId && { "Mcp-Session-Id": response.sessionId }),
        },
      });
    }

    return Response.json(response.body, {
      headers: response.sessionId ? { "Mcp-Session-Id": response.sessionId } : {},
    });
  } catch (error) {
    console.error("[MCP] Error handling request:", error);
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null },
      { status: 500 }
    );
  }
}

// GET endpoint for server-initiated messages (optional)
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const mcpSessionId = request.headers.get("mcp-session-id");
  if (!mcpSessionId || !sessions.has(mcpSessionId)) {
    // No active session - return 405 per spec
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Return SSE stream for server-to-client messages
  // Implementation depends on whether server needs to push messages
  return new Response("Not Implemented", { status: 501 });
}

// DELETE endpoint to terminate session
export async function DELETE(request: Request) {
  const mcpSessionId = request.headers.get("mcp-session-id");
  if (mcpSessionId) {
    sessions.delete(mcpSessionId);
  }
  return new Response(null, { status: 204 });
}

function isAllowedOrigin(origin: string): boolean {
  const allowed = [
    process.env.NEXT_PUBLIC_SITE_URL,
    "http://localhost:3000",
  ].filter(Boolean);
  return allowed.some(url => origin.startsWith(url as string));
}
```

#### Simplified Stateless Implementation

For simpler deployments where session management isn't needed:

```typescript
// Stateless implementation - each request is independent
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Create fresh MCP server for each request (stateless)
  const mcpServer = new McpServer({
    name: "fabric-browser-automation",
    version: "1.0.0",
  });

  registerBrowserTools(mcpServer, {
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId,
  });

  const transport = new StreamableHTTPServerTransport();
  await mcpServer.connect(transport);

  const body = await request.json();
  const response = await transport.handleRequest(body);

  return Response.json(response);
}
```

> **Note**: The stateless approach works for fabric because each tool call triggers an independent Temporal workflow. For MCP servers that need conversation state, use the stateful implementation above.

### stdio Transport (For Local Development with Claude Desktop)

stdio transport runs the MCP server as a subprocess, communicating via stdin/stdout. This is the **recommended approach for local Claude Desktop integration**.

#### MCP Spec Compliance (2025-03-26)

Per the [MCP Transports Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports):

| Requirement | Implementation |
|-------------|----------------|
| Client launches server as subprocess | ✅ Via `npx @fabricorg/mcp-server` |
| Server reads JSON-RPC from stdin | ✅ Handled by `StdioServerTransport` |
| Server writes JSON-RPC to stdout | ✅ Handled by `StdioServerTransport` |
| Messages delimited by newlines | ✅ Handled by SDK |
| No embedded newlines in messages | ✅ Handled by SDK |
| Logging to stderr only | ✅ Using `console.error()` |
| MUST NOT write non-MCP to stdout | ✅ All output via SDK transport |

#### Package Structure

Create a standalone CLI package that can be run via npx:

```
packages/mcp-server/
├── package.json          # @fabricorg/mcp-server
├── bin/
│   └── cli.ts           # Entry point for npx
├── src/
│   ├── server.ts        # MCP server setup
│   ├── tools/           # Tool implementations
│   └── temporal-client.ts
└── tsconfig.json
```

#### CLI Entry Point

```typescript
#!/usr/bin/env node
// packages/mcp-server/bin/cli.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBrowserTools } from "../src/tools";

async function main() {
  // Get credentials from environment variables
  const userId = process.env.FABRIC_USER_ID;
  const organizationId = process.env.FABRIC_ORG_ID;
  const apiKey = process.env.FABRIC_API_KEY;
  const apiUrl = process.env.FABRIC_API_URL || "http://localhost:3000";

  if (!userId || !apiKey) {
    console.error("Error: FABRIC_USER_ID and FABRIC_API_KEY are required");
    console.error("Set these in your Claude Desktop config or environment");
    process.exit(1);
  }

  // Create MCP server
  const mcpServer = new McpServer({
    name: "fabric-browser-automation",
    version: "1.0.0",
  });

  // Register tools with user context
  registerBrowserTools(mcpServer, {
    userId,
    organizationId,
    apiKey,
    apiUrl,
  });

  // Use stdio transport for Claude Desktop
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error("Fabric MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

#### Tool Implementation (Calls Remote Temporal via API)

```typescript
// packages/mcp-server/src/tools/browser-task.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerBrowserTaskTool(
  mcpServer: McpServer,
  context: { userId: string; organizationId?: string; apiKey: string; apiUrl: string }
) {
  mcpServer.tool(
    'run_browser_task',
    {
      description: 'Execute browser automation task with Playwright',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Starting URL' },
          actions: { type: 'array', description: 'Browser actions' },
          extractors: { type: 'array', description: 'Content extractors' },
        },
        required: ['url'],
      },
    },
    async (input) => {
      // Call fabric-portal API to start Temporal workflow
      const response = await fetch(`${context.apiUrl}/api/browser-automation/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${context.apiKey}`,
        },
        body: JSON.stringify({
          ...input,
          userId: context.userId,
          organizationId: context.organizationId,
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${await response.text()}`);
      }

      const result = await response.json();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}
```

#### package.json for MCP Server Package

```json
{
  "name": "@fabricorg/mcp-server",
  "version": "1.0.0",
  "description": "MCP server for Fabric browser automation",
  "bin": {
    "fabric-mcp": "./dist/bin/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "pnpm build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### Tool Registration Pattern (Fabric-specific)

```typescript
// MCP tool registration wrapping Temporal workflows
function registerBrowserTools(
  mcpServer: McpServer,
  context: { userId: string; organizationId?: string }
) {
  // Tool 1: run_browser_task
  mcpServer.tool(
    'run_browser_task',
    {
      description: 'Execute browser automation task with Playwright',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Starting URL' },
          actions: {
            type: 'array',
            description: 'Browser actions (click, type, navigate, etc.)',
            items: { $ref: '#/definitions/BrowserAction' }
          },
          extractors: {
            type: 'array',
            description: 'Content extractors',
            items: { $ref: '#/definitions/ContentExtractor' }
          },
        },
        required: ['url'],
      },
    },
    async (input) => {
      const result = await temporalClient.workflow.execute(
        'browserAutomationWorkflow',
        {
          taskQueue: 'browser-automation',
          workflowId: `mcp-browser-${Date.now()}`,
          args: [{
            ...input,
            userId: context.userId,
            organizationId: context.organizationId,
          }],
        }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // Tool 2: run_hybrid_task (enhanced version of CUGA's)
  mcpServer.tool(
    'run_hybrid_task',
    {
      description: 'Execute hybrid API+browser task with intelligent fallback',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['api-first', 'browser-first', 'api-only', 'browser-only', 'parallel'],
            description: 'Execution mode (fabric supports 5 modes vs CUGA\'s 1)'
          },
          steps: {
            type: 'array',
            description: 'API and browser steps to execute',
            items: { $ref: '#/definitions/HybridStep' }
          },
          fallbackOnError: { type: 'boolean', default: true },
        },
        required: ['mode', 'steps'],
      },
    },
    async (input) => {
      const result = await temporalClient.workflow.execute(
        'hybridExecutionWorkflow',
        {
          taskQueue: 'browser-automation',
          workflowId: `mcp-hybrid-${Date.now()}`,
          args: [{
            ...input,
            taskId: `mcp-${Date.now()}`,
            userId: context.userId,
            organizationId: context.organizationId,
          }],
        }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // Tool 3: execute_template (fabric-only, not in CUGA)
  mcpServer.tool(
    'execute_template',
    {
      description: 'Execute a saved automation template with parameters',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'Template ID to execute' },
          parameters: {
            type: 'object',
            description: 'Parameter values for {{param}} placeholders'
          },
        },
        required: ['templateId'],
      },
    },
    async (input) => {
      const result = await temporalClient.workflow.execute(
        'templateExecutionWorkflow',
        {
          taskQueue: 'browser-automation',
          workflowId: `mcp-template-${Date.now()}`,
          args: [{
            templateId: input.templateId,
            taskId: `mcp-${Date.now()}`,
            userId: context.userId,
            organizationId: context.organizationId,
            parameterValues: input.parameters || {},
          }],
        }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // Tool 4: extract_web_content (fabric-only, not in CUGA)
  mcpServer.tool(
    'extract_web_content',
    {
      description: 'Extract content from a URL for RAG/AI context',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to extract content from' },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS selectors for content extraction'
          },
          format: {
            type: 'string',
            enum: ['text', 'markdown', 'html'],
            default: 'markdown'
          },
        },
        required: ['url'],
      },
    },
    async (input) => {
      const result = await temporalClient.workflow.execute(
        'browserRagIngestionWorkflow',
        {
          taskQueue: 'browser-automation',
          workflowId: `mcp-rag-${Date.now()}`,
          args: [{
            ...input,
            userId: context.userId,
            organizationId: context.organizationId,
          }],
        }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
}
```

### Client Configuration Examples

#### Claude Desktop Configuration (Local stdio via npx)

For local development with Claude Desktop, use stdio transport via npx:

```json
{
  "mcpServers": {
    "fabric-browser": {
      "command": "npx",
      "args": ["@fabricorg/mcp-server"],
      "env": {
        "FABRIC_USER_ID": "<your-user-id>",
        "FABRIC_API_KEY": "<your-api-key>",
        "FABRIC_ORG_ID": "<your-org-id>",
        "FABRIC_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

Or if installed globally/locally:

```json
{
  "mcpServers": {
    "fabric-browser": {
      "command": "fabric-mcp",
      "env": {
        "FABRIC_USER_ID": "<your-user-id>",
        "FABRIC_API_KEY": "<your-api-key>",
        "FABRIC_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

#### Remote MCP Client (Streamable HTTP)

For remote/production deployments, use Streamable HTTP transport:

```json
{
  "mcpServers": {
    "fabric-browser-remote": {
      "url": "https://your-fabric-instance.com/api/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}
```

#### Programmatic Client Usage (TypeScript)

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Connect to remote fabric MCP server
const transport = new StreamableHTTPClientTransport(
  new URL("https://your-fabric-instance.com/api/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  }
);

const mcpClient = await createMCPClient({ transport });

// List available tools
const tools = await mcpClient.tools();
console.log("Available tools:", tools);

// Call a tool
const result = await mcpClient.callTool("run_browser_task", {
  url: "https://example.com",
  actions: [{ type: "screenshot" }],
});
```

### Transport Selection Guide

| Scenario | Recommended Transport | Configuration |
|----------|----------------------|---------------|
| Claude Desktop (local) | **stdio** | `npx @fabricorg/mcp-server` |
| Local development | **stdio** | `npx @fabricorg/mcp-server` |
| Production/Cloud deployment | Streamable HTTP | `POST /api/mcp` |
| Behind load balancer | Streamable HTTP | `POST /api/mcp` |
| Serverless (Vercel, etc.) | Streamable HTTP | `POST /api/mcp` |
| AI SDK integration | Streamable HTTP | `POST /api/mcp` |

## 9. References

### MCP Specification
- [MCP Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP Transports Specification (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) - Authoritative spec for stdio and Streamable HTTP
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### CUGA Reference
- [CUGA GitHub Repository](https://github.com/cuga-project/cuga-agent) - Original inspiration
- [CUGA as MCP Example](https://github.com/cuga-project/cuga-agent/tree/main/docs/examples/cuga_as_mcp)

### Fabric-Portal Implementation
- [Browser Automation Architecture](./ARCHITECTURE.md)
- [Hybrid Execution Workflow](../../../packages/temporal/src/workflows/hybrid-execution.ts)
- [Template Execution Workflow](../../../packages/temporal/src/workflows/template-execution.ts)
- [Existing MCP Client](../../../packages/mcp/lib/client.ts) - Client implementation for connecting to MCP servers

## 10. Conclusion

**Fabric-portal should expose its existing browser automation capabilities as an MCP server** rather than integrating CUGA's external MCP server. This approach:

1. **Leverages existing investment** in browser automation workflows
2. **Provides more features** than CUGA (5 hybrid modes, templates, RAG)
3. **Maintains architectural consistency** with the rest of fabric-portal
4. **Avoids duplication** of effort and code
5. **Enables Claude Desktop and other AI agents** to use fabric's capabilities

The implementation plan above provides a 4-week roadmap to expose these capabilities while maintaining security and multi-tenancy.


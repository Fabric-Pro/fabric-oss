# Cloudflare Sandbox Implementation Guide

This document describes the implementation of secure code execution using Cloudflare Sandbox in the Fabric Portal.

## Overview

The Cloudflare Sandbox integration provides secure, isolated code execution for Python, JavaScript, and TypeScript. It consists of:

1. **Backend API Module** - oRPC-based API endpoints for code execution
2. **Frontend Component** - React component for code editing and output display
3. **Type Definitions** - Shared types for execution results and rich output

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         AgentTryCode Component                        │  │
│  │  - Code Editor (Textarea)                             │  │
│  │  - Language Selector (Python/JS/TS)                   │  │
│  │  - Execute Button                                     │  │
│  │  - Output Display (Logs, Results, Errors)             │  │
│  └───────────────────────────────────────────────────────┘  │
│                          ↓ orpcClient                       │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                   Backend API (oRPC)                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         Sandbox Router (/api/sandbox/*)               │  │
│  │  - createContext: Create execution context            │  │
│  │  - executeCode: Run code in sandbox                   │  │
│  │  - listContexts: List user contexts                   │  │
│  │  - deleteContext: Cleanup contexts                    │  │
│  └───────────────────────────────────────────────────────┘  │
│                          ↓                                  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Sandbox (Production)                │
│  - Isolated execution environments                          │
│  - Durable Objects for state persistence                    │
│  - WebSocket streaming for real-time output                 │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. Backend API Module

**Location**: `packages/api/modules/sandbox/`

#### File Structure

```
packages/api/modules/sandbox/
├── types.ts                      # Type definitions
├── router.ts                     # Main router
├── procedures/
│   ├── create-context.ts        # Create execution context
│   ├── execute-code.ts          # Execute code
│   ├── list-contexts.ts         # List contexts
│   └── delete-context.ts        # Delete context
└── README.md                     # API documentation
```

#### Key Types (`types.ts`)

```typescript
// Supported languages
export const LanguageSchema = z.enum(["python", "javascript", "typescript"]);

// Code execution context
export const CodeContextSchema = z.object({
  id: z.string(),
  language: LanguageSchema,
  cwd: z.string().optional(),
  createdAt: z.string(),
  lastUsed: z.string(),
});

// Rich output formats
export const OutputFormatSchema = z.enum([
  "text", "html", "png", "svg", "json", "chart"
]);

// Log entry
export const LogEntrySchema = z.object({
  type: z.enum(["stdout", "stderr"]),
  text: z.string(),
  timestamp: z.string().optional(),
});

// Execution result
export const ExecutionResultSchema = z.object({
  code: z.string(),
  logs: z.array(LogEntrySchema),
  results: z.array(RichOutputSchema).optional(),
  error: z.string().optional(),
  executionCount: z.number().optional(),
  executionTime: z.number().optional(),
});
```

#### API Endpoints

**1. Create Context**
```typescript
// POST /api/sandbox/contexts/create
protectedProcedure
  .input(z.object({
    language: LanguageSchema.default("python"),
    cwd: z.string().optional(),
    envVars: z.record(z.string()).optional(),
  }))
  .output(CodeContextSchema)
```

**2. Execute Code**
```typescript
// POST /api/sandbox/execute
protectedProcedure
  .input(z.object({
    code: z.string().min(1),
    contextId: z.string().optional(),
    language: LanguageSchema.default("python"),
    timeout: z.number().min(1000).max(60000).default(30000),
    stream: z.boolean().default(false),
  }))
  .output(ExecutionResultSchema)
```

**3. List Contexts**
```typescript
// GET /api/sandbox/contexts
protectedProcedure
  .output(z.array(CodeContextSchema))
```

**4. Delete Context**
```typescript
// DELETE /api/sandbox/contexts/:contextId
protectedProcedure
  .input(z.object({ contextId: z.string() }))
  .output(z.object({ success: z.boolean() }))
```

#### Router Integration

Add to `packages/api/orpc/router.ts`:

```typescript
import { sandboxRouter } from "../modules/sandbox/router";

export const router = publicProcedure
  .prefix("/api")
  .router({
    // ... other routers
    sandbox: sandboxRouter,
    // ... other routers
  });
```

### 2. Frontend Component

**Location**: `apps/web/modules/saas/agents/components/AgentTryCode.tsx`

#### Component Structure

```typescript
export function AgentTryCode(_props: AgentTryCodeProps) {
  // State management
  const [language, setLanguage] = useState<"python" | "javascript" | "typescript">("python");
  const [code, setCode] = useState(DEFAULT_CODE.python);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [contextId] = useState<string | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  // Handlers
  const handleLanguageChange = (newLanguage) => { /* ... */ };
  const handleExecute = async () => { /* ... */ };
  const handleClearOutput = () => { /* ... */ };
  const renderRichOutput = (output, index) => { /* ... */ };

  // UI Layout: Split-pane (Code Editor | Output)
}
```

#### Default Code Templates

```typescript
const DEFAULT_CODE = {
  python: `# Write your Python code here
import math

# Calculate the area of a circle
radius = 5
area = math.pi * radius ** 2
print(f"Area of circle with radius {radius}: {area:.2f}")

# Return the result (last expression is automatically captured)
area`,
  javascript: `// Write your JavaScript code here
const numbers = [1, 2, 3, 4, 5];

// Calculate sum
const sum = numbers.reduce((a, b) => a + b, 0);
console.log(\`Sum: \${sum}\`);

// Return the result
sum;`,
  typescript: `// Write your TypeScript code here
interface User {
  name: string;
  age: number;
}

const user: User = { name: "Alice", age: 30 };
console.log(\`User: \${user.name}, Age: \${user.age}\`);

// Return the result
user;`,
};
```

#### Execute Handler

```typescript
const handleExecute = async () => {
  if (!code.trim()) {
    toast.error("Please enter some code to execute");
    return;
  }

  setIsExecuting(true);
  const startTime = Date.now();

  try {
    // Execute code via Cloudflare Sandbox API
    const executionResult = await orpcClient.sandbox.execute({
      code,
      language,
      contextId: contextId || undefined,
      timeout: 30000,
    });

    setResult({
      ...executionResult,
      executionTime: executionResult.executionTime || Date.now() - startTime,
    });

    toast.success("Code executed successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to execute code";
    toast.error("Execution failed", { description: errorMessage });

    setResult({
      code,
      logs: [{ type: "stderr", text: errorMessage }],
      error: errorMessage,
      executionTime: Date.now() - startTime,
    });
  } finally {
    setIsExecuting(false);
  }
};
```

#### Rich Output Rendering

```typescript
const renderRichOutput = (output: RichOutput, index: number) => {
  switch (output.type) {
    case "text":
      return (
        <pre key={index} className="bg-muted p-3 rounded text-xs font-mono whitespace-pre-wrap">
          {output.text}
        </pre>
      );
    case "html":
      return (
        <div
          key={index}
          className="bg-muted p-3 rounded"
          dangerouslySetInnerHTML={{ __html: output.html || "" }}
        />
      );
    case "png":
      return (
        <div key={index} className="bg-muted p-3 rounded">
          <img src={`data:image/png;base64,${output.png}`} alt="Output" className="max-w-full" />
        </div>
      );
    case "svg":
      return (
        <div
          key={index}
          className="bg-muted p-3 rounded"
          dangerouslySetInnerHTML={{ __html: output.svg || "" }}
        />
      );
    case "json":
      return (
        <pre key={index} className="bg-muted p-3 rounded text-xs font-mono overflow-auto">
          {JSON.stringify(output.json, null, 2)}
        </pre>
      );
    default:
      return null;
  }
};
```

#### UI Layout

The component uses a split-pane layout:

**Left Panel - Code Editor:**
- Header with language selector and execute button
- Textarea for code input (can be upgraded to Monaco Editor)
- Language-specific placeholder text

**Right Panel - Output:**
- Header with clear button
- Execution status badges (Success/Error, execution time)
- STDOUT/STDERR logs with proper styling
- Rich output results (text, HTML, images, JSON)
- Error messages with destructive styling
- Auto-scroll to latest output

### 3. Configuration

#### Environment Variables

Add to `.env.example`:

```bash
# Cloudflare Sandbox (Secure Code Execution)
# Provides isolated code execution environment for Python, JavaScript, TypeScript
# Documentation: https://developers.cloudflare.com/sandbox/
# Note: Requires Cloudflare Workers Durable Objects binding configured in wrangler.toml
# This is automatically configured when deploying to Cloudflare Workers
# For local development, the API uses mock responses until Cloudflare Sandbox is configured
CLOUDFLARE_SANDBOX_BINDING_NAME="Sandbox"
```

#### Cloudflare Workers Configuration

Create/update `wrangler.toml`:

```toml
name = "fabric-api"
compatibility_flags = ["nodejs_compat"]

# Cloudflare Sandbox configuration
[[durable_objects.bindings]]
name = "Sandbox"
class_name = "Sandbox"
script_name = "fabric-api"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Sandbox"]

[[containers]]
class_name = "Sandbox"
image = "./Dockerfile"
```

## Current Implementation Status

### ✅ Completed

1. **Backend API Module**
   - Type definitions for all Cloudflare Sandbox entities
   - Four oRPC procedures (create, execute, list, delete)
   - Router integration with main API
   - Comprehensive documentation

2. **Frontend Component**
   - Code editor with language selector
   - Execute button with loading states
   - Output display with rich formatting
   - Error handling and user feedback
   - Auto-scroll and clear functionality

3. **Configuration**
   - Environment variable documentation
   - Cloudflare Workers setup guide
   - API documentation with examples

### 🔄 Development Mode

The implementation currently uses **mock responses** for testing. The API structure is complete and ready for Cloudflare Sandbox integration.

**Mock Response Example:**
```typescript
const mockResult = {
  code,
  logs: [
    { type: "stdout", text: "Mock execution - Cloudflare Sandbox not yet configured" },
    { type: "stdout", text: `Language: ${language}` },
    { type: "stdout", text: `Context: ${contextId || "temporary"}` },
  ],
  results: [{ type: "text", text: "Code execution successful (mock)" }],
  executionCount: 1,
  executionTime: 150,
};
```

## Production Integration Steps

To enable actual Cloudflare Sandbox execution:

### 1. Update Procedure Handlers

Replace mock responses with Cloudflare Sandbox SDK calls:

```typescript
// packages/api/modules/sandbox/procedures/execute-code.ts
export const executeCode = protectedProcedure
  .handler(async ({ input, context }) => {
    const { code, contextId, language, timeout } = input;

    // Get sandbox instance for user
    const sandbox = getSandbox(env.Sandbox, context.user.id);

    // Create or get context
    const ctx = contextId
      ? await sandbox.getCodeContext(contextId)
      : await sandbox.createCodeContext({ language });

    // Execute code with streaming
    const result = await sandbox.runCode(code, {
      context: ctx.id,
      timeout,
      stream: input.stream,
      onOutput: (data) => {
        // Handle streaming output
      },
      onResult: (result) => {
        // Handle execution result
      },
      onError: (error) => {
        // Handle execution error
      },
    });

    return {
      code,
      logs: result.logs,
      results: result.results,
      error: result.error,
      executionTime: result.executionTime,
    };
  });
```

### 2. Deploy to Cloudflare Workers

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy
wrangler deploy
```

### 3. Configure Durable Objects

Ensure `wrangler.toml` has the correct Durable Objects configuration (see Configuration section above).

### 4. Test Production Deployment

```bash
# Test code execution
curl -X POST https://your-worker.workers.dev/api/sandbox/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "code": "print(\"Hello from Cloudflare Sandbox!\")",
    "language": "python"
  }'
```

## Security Considerations

1. **Isolation**: All code runs in isolated Cloudflare Sandbox environments
2. **Authentication**: All endpoints use `protectedProcedure` requiring user authentication
3. **Timeouts**: Configurable execution timeouts (default 30s, max 60s)
4. **Resource Limits**: Cloudflare Sandbox enforces memory and CPU limits
5. **Input Validation**: Zod schemas validate all inputs
6. **User Scoping**: Contexts are scoped to individual users

## Usage Examples

### Execute Python Code

```typescript
import { orpcClient } from "@shared/lib/orpc-client";

const result = await orpcClient.sandbox.execute({
  code: `
import math
radius = 5
area = math.pi * radius ** 2
print(f"Area: {area:.2f}")
area
  `,
  language: "python",
  timeout: 30000,
});

console.log(result.logs); // [{ type: "stdout", text: "Area: 78.54\n" }]
console.log(result.results); // [{ type: "text", text: "78.53981633974483" }]
```

### Execute JavaScript with Context

```typescript
// Create a persistent context
const context = await orpcClient.sandbox.contexts.create({
  language: "javascript",
});

// Execute code in context (variables persist)
const result1 = await orpcClient.sandbox.execute({
  code: "const x = 10; console.log(x);",
  language: "javascript",
  contextId: context.id,
});

// Variables from previous execution are available
const result2 = await orpcClient.sandbox.execute({
  code: "console.log(x * 2);",
  language: "javascript",
  contextId: context.id,
});

// Cleanup
await orpcClient.sandbox.contexts.delete({ contextId: context.id });
```

## Future Enhancements

1. **Monaco Editor**: Upgrade from Textarea to Monaco Editor for better code editing
2. **Syntax Highlighting**: Add language-specific syntax highlighting
3. **Code Completion**: Implement autocomplete for common libraries
4. **File Operations**: Add file upload/download capabilities
5. **WebSocket Streaming**: Implement real-time output streaming
6. **Command Execution**: Add shell command execution support
7. **Package Installation**: Allow installing packages in contexts
8. **Execution History**: Store and display execution history
9. **Code Snippets**: Provide library of example code snippets
10. **Collaborative Editing**: Multi-user code editing with Liveblocks

## References

- [Cloudflare Sandbox Documentation](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [oRPC Documentation](https://orpc.dev)
- [Zod Documentation](https://zod.dev)

## Troubleshooting

### Mock Responses in Production

**Problem**: API returns mock responses instead of executing code.

**Solution**: Ensure Cloudflare Sandbox binding is configured in `wrangler.toml` and procedure handlers are updated to use `getSandbox()`.

### Timeout Errors

**Problem**: Code execution times out.

**Solution**: Increase timeout value (max 60s) or optimize code. Check Cloudflare Sandbox resource limits.

### Context Not Found

**Problem**: `contextId` not found error.

**Solution**: Verify context exists and belongs to the current user. Contexts may expire after inactivity.

### Rich Output Not Displaying

**Problem**: Images or charts not rendering.

**Solution**: Ensure output format is correctly set and data is properly encoded (base64 for images).

---

**Last Updated**: 2024-12-20
**Status**: Development Mode (Mock Responses)
**Next Steps**: Deploy to Cloudflare Workers and integrate Sandbox SDK
```



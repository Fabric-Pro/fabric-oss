# Temporal Workflow Durability

How Workflow Editor executions use Temporal for durable, resumable, node-by-node execution.

- **Audience**: engineers working on workflow execution, retries or approvals
- **Owner**: Fabric platform team

## Overview

Fabric uses [Temporal](https://temporal.io) as the workflow orchestration engine. This provides:

- **Durability**: Workflows survive process restarts and infrastructure failures
- **Reliability**: Automatic retries with configurable backoff
- **Visibility**: Full execution history and debugging tools
- **Scalability**: Handle thousands of concurrent workflow executions

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      WORKFLOW EXECUTION FLOW                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │   Trigger    │    │   Temporal   │    │   Temporal Worker    │  │
│  │  (UI/API)    │───▶│   Server     │───▶│   (fabric-worker)    │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│                             │                      │                │
│                             │                      │                │
│                             ▼                      ▼                │
│                      ┌──────────────┐    ┌──────────────────────┐  │
│                      │  Event       │    │   Node Activities    │  │
│                      │  History     │    │   - AI Generation    │  │
│                      │  (Durable)   │    │   - HTTP Requests    │  │
│                      └──────────────┘    │   - Integrations     │  │
│                                          └──────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### Workflows

The main workflow is `workflowBuilderExecutionWorkflow`:

```typescript
export async function workflowBuilderExecutionWorkflow(
  input: WorkflowBuilderExecutionInput,
): Promise<WorkflowBuilderExecutionOutput> {
  // Durable execution logic
  // Each step is recorded in Temporal's event history
}
```

**Input:**
```typescript
interface WorkflowBuilderExecutionInput {
  executionId: string;      // Database execution record ID
  workflowId: string;       // Workflow definition ID
  userId: string;           // User who triggered the workflow
  organizationId?: string;  // Organization context (multi-tenancy)
  triggerData?: Record<string, unknown>;  // Dynamic payload
  variables?: Record<string, unknown>;    // Workflow variables
  nodes?: WorkflowNode[];   // Node definitions (optional, can fetch)
  edges?: WorkflowEdge[];   // Edge definitions (optional, can fetch)
}
```

**Output:**
```typescript
interface WorkflowBuilderExecutionOutput {
  executionId: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  outputs: Record<string, unknown>;  // Outputs from each node
  error?: string;
  executedNodes: string[];  // IDs of nodes that ran
  duration: number;         // Total execution time in ms
}
```

### Activities

Activities are the actual work units (API calls, AI generation, etc.):

```typescript
const {
  executeWorkflowNode,
  updateWorkflowExecutionStatus,
  createWorkflowExecutionLog,
  getWorkflowDefinition,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
    maximumAttempts: 3,
  },
});
```

### Step Registry

Node execution is modular via the step registry pattern:

```typescript
// packages/temporal/src/activities/lib/step-registry.ts
export const stepRegistry: Record<string, StepRegistryEntry> = {
  "trigger": { 
    name: "Trigger", 
    load: async () => (await import("./steps/trigger")).executeTriggerStep 
  },
  "ai-generate-text": { 
    name: "Generate Text", 
    load: async () => (await import("./steps/ai-generate-text")).executeAiGenerateTextStep 
  },
  // ... all node types
};

export async function executeStep(
  nodeType: string, 
  params: StepParams
): Promise<NodeExecutionResult> {
  const entry = stepRegistry[nodeType];
  const stepFunction = await entry.load();
  return stepFunction(params);
}
```

## Execution Model

### Topological Execution

Nodes are executed in dependency order:

```
1. Build dependency graph from edges
2. Find starting nodes (no incoming edges or type=trigger)
3. Execute nodes in queue order:
   - Wait for all dependencies to complete
   - Collect inputs from predecessor outputs
   - Execute node activity
   - Store output for downstream nodes
   - Add successor nodes to queue
4. Continue until all nodes executed or error
```

### Condition Node Handling

Condition nodes create branching paths:

```typescript
if (node.type === "condition" && result.output) {
  const conditionResult = result.output as { result: boolean };
  const targetHandle = conditionResult.result ? "true" : "false";
  
  // Only follow the matching branch
  const nextEdges = edges.filter(
    (e) => e.source === nodeId && e.sourceHandle === targetHandle,
  );
}
```

### Variable Interpolation

The `interpolateTemplate` function resolves references:

```typescript
function interpolateTemplate(
  template: string,
  variables: Record<string, unknown>
): string {
  // Matches {{NodeLabel.field}} or {{$nodeId.field}}
  return template.replace(
    /\{\{([\w\s$.-]+)\}\}/g,
    (match, path) => {
      const value = getNestedValue(variables, path.trim());
      return value ?? match;
    }
  );
}
```

## Retry Behavior

### Activity Retries

Each node execution has automatic retries:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `startToCloseTimeout` | 10 minutes | Maximum time for a single attempt |
| `initialInterval` | 1 second | Wait time before first retry |
| `backoffCoefficient` | 2 | Exponential backoff multiplier |
| `maximumInterval` | 60 seconds | Maximum wait between retries |
| `maximumAttempts` | 3 | Total number of attempts |

### Retry Timeline Example

```
Attempt 1: Execute → Fail
Wait: 1 second
Attempt 2: Execute → Fail
Wait: 2 seconds (1s × 2)
Attempt 3: Execute → Fail
→ Activity fails permanently
```

### Non-Retryable Errors

Some errors should not be retried:

```typescript
import { ApplicationFailure } from "@temporalio/workflow";

throw ApplicationFailure.nonRetryable(
  "Invalid API key",
  "AUTHENTICATION_ERROR"
);
```

## State Persistence

### What Gets Persisted

1. **Workflow Input**: Full input parameters
2. **Event History**: Every activity call and result
3. **Timer Events**: Sleep/wait operations
4. **Signals/Queries**: External interactions

### Recovery Scenarios

| Scenario | Behavior |
|----------|----------|
| Worker crash | Workflow continues on another worker |
| Server restart | Workflow resumes from last checkpoint |
| Network timeout | Activity retries automatically |
| Long-running AI call | Heartbeats keep execution alive |

## Monitoring & Debugging

### Temporal UI

Access the Temporal UI to:

- View running and completed workflows
- Inspect event history
- Debug failed executions
- Terminate stuck workflows

### Execution Logs

Each node writes logs to the database:

```typescript
await createWorkflowExecutionLog({
  executionId: input.executionId,
  nodeId,
  nodeType: node.type,
  status: "RUNNING",
  startedAt: new Date(),
});

// After execution
await createWorkflowExecutionLog({
  executionId: input.executionId,
  nodeId,
  nodeType: node.type,
  status: result.success ? "COMPLETED" : "FAILED",
  output: result.output,
  error: result.error,
  completedAt: new Date(),
});
```

### Query Workflow State

```typescript
// Get current state of a running workflow
const handle = client.getHandle(workflowId);
const state = await handle.query("getState");
```

## Configuration

### Task Queue

All workflow activities use the `fabric-worker` task queue:

```typescript
const handle = await temporalClient.workflow.start(
  "workflowBuilderExecutionWorkflow",
  {
    taskQueue: "fabric-worker",
    workflowId: `workflow-${execution.id}`,
    args: [input],
  },
);
```

### Worker Configuration

```typescript
// packages/temporal/src/worker.ts
const worker = await Worker.create({
  workflowsPath: require.resolve("./workflows"),
  activities,
  taskQueue: "fabric-worker",
  maxConcurrentActivityTaskExecutions: 100,
  maxConcurrentWorkflowTaskExecutions: 100,
});
```

## Error Handling

### Node Failure

When a node fails:

1. Error is logged with details
2. Workflow status updated to FAILED
3. Downstream nodes are not executed
4. Full execution history preserved

```typescript
if (!result.success) {
  throw new Error(`Node ${nodeId} failed: ${result.error}`);
}
```

### Graceful Degradation

For non-critical nodes, you can implement fallback logic:

```typescript
export async function executeMyStep(params: StepParams): Promise<NodeExecutionResult> {
  try {
    const result = await riskyOperation();
    return { success: true, output: result };
  } catch (error) {
    // Return success with fallback value instead of failing
    return { 
      success: true, 
      output: { 
        warning: "Used fallback",
        data: defaultValue 
      } 
    };
  }
}
```

## Best Practices

### 1. Keep Activities Idempotent

Activities may be retried, so ensure they're safe to run multiple times:

```typescript
// Good: Use unique keys for external operations
await createSlackMessage({
  channel: config.channel,
  text: config.message,
  idempotencyKey: `${executionId}-${nodeId}`,
});
```

### 2. Use Heartbeats for Long Operations

For operations over 30 seconds:

```typescript
import { heartbeat } from "@temporalio/activity";

async function longRunningActivity() {
  for (const item of items) {
    await processItem(item);
    heartbeat(); // Tell Temporal we're still alive
  }
}
```

### 3. Handle Cancellation

Respect workflow cancellation:

```typescript
import { CancelledError, isCancellation } from "@temporalio/workflow";

try {
  await executeNode();
} catch (error) {
  if (isCancellation(error)) {
    // Cleanup and exit gracefully
    await cleanup();
    throw error;
  }
  throw error;
}
```

### 4. Log Context

Include relevant context in error messages:

```typescript
console.error(`[${nodeType}] Failed for user ${userId}:`, error.message);
```

## Scaling Considerations

### Horizontal Scaling

- Start multiple worker instances
- Temporal distributes work automatically
- No coordination required

### Rate Limiting

Implement rate limiting in activities:

```typescript
const rateLimiter = new RateLimiter({ 
  tokensPerInterval: 10, 
  interval: "second" 
});

export async function executeApiCall() {
  await rateLimiter.removeTokens(1);
  return fetch(url);
}
```

### Resource Isolation

For multi-tenant deployments:

```typescript
// Use organization-specific task queues for isolation
const taskQueue = organizationId 
  ? `fabric-worker-${organizationId}`
  : "fabric-worker";
```

## Troubleshooting

### Workflow Stuck

1. Check Temporal UI for event history
2. Look for pending activities
3. Check worker logs for errors
4. Verify worker is running and connected

### Retries Not Working

1. Verify retry policy configuration
2. Check if error is marked non-retryable
3. Ensure activity timeout is appropriate

### Slow Executions

1. Profile individual activities
2. Check for external API latency
3. Consider parallel execution for independent nodes
4. Review retry delays

---

## Related Documentation

- [Publishing & Triggers](./publishing-and-triggers.md)
- [Node Types Reference](./node-types.md)
- [Temporal Official Docs](https://docs.temporal.io)


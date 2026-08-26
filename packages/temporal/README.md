# Temporal Workflow Orchestration

This package provides durable workflow orchestration for the fabric-portal application using [Temporal.io](https://temporal.io/).

## Overview

Temporal provides durable execution for long-running operations with automatic retries, state persistence, and complete execution history. This is particularly useful for AI operations that may fail due to:

- Network timeouts
- API rate limits
- Temporary service unavailability
- Database connection issues

## Features

- **Automatic Retries**: Configurable retry policies with exponential backoff
- **Durable Execution**: Workflows survive process crashes and restarts
- **Complete History**: Full execution history for debugging and auditing
- **State Persistence**: Workflow state is automatically persisted
- **Observability**: Built-in Web UI for monitoring workflows

## Architecture

```
┌─────────────────┐
│   Next.js App   │
│  (API Routes)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────────┐
│ Temporal Server │◄────►│  Worker Process  │
│   (Docker)      │      │  (TypeScript)    │
└─────────────────┘      └────────┬─────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐      ┌──────────────────┐
│   PostgreSQL    │      │   PostgreSQL     │
│ (Temporal State)│      │ (App Database)   │
└─────────────────┘      └──────────────────┘
```

## Setup

### 1. Start Temporal Server

The Temporal Server is configured in `docker-compose.yml`:

```bash
# Start all services including Temporal
docker-compose up -d

# Or start only Temporal
docker-compose up -d temporal
```

The Temporal Web UI will be available at: http://localhost:8233

### 2. Install Dependencies

Dependencies are automatically installed when you run `pnpm install` in the root directory.

### 3. Configure Environment Variables

Add to your `.env.local`:

```bash
# Enable Temporal workflows (default: false)
ENABLE_TEMPORAL_WORKFLOWS="true"

# Local development (default)
TEMPORAL_ADDRESS="localhost:7233"
TEMPORAL_NAMESPACE="default"

# Production (Temporal Cloud)
# TEMPORAL_ADDRESS="your-namespace.tmprl.cloud:7233"
# TEMPORAL_NAMESPACE="your-namespace"
# TEMPORAL_CLOUD_API_KEY="your-api-key"
# TEMPORAL_TLS="true"
```

### 4. Run Database Migration

Apply the database migration to add Temporal fields:

```bash
# Apply migration
pnpm --filter @repo/database exec prisma migrate deploy

# Or for development
pnpm --filter @repo/database exec prisma migrate dev
```

### 5. Start Worker

The worker polls Temporal Server for tasks and executes workflows and activities:

```bash
# Start worker
pnpm --filter @repo/temporal worker

# Or with auto-reload for development
pnpm --filter @repo/temporal worker:dev
```

## Usage

### Starting a Workflow

From an API route or server action:

```typescript
import { getTemporalClient } from '@repo/temporal';
import { chatTitleGenerationWorkflow } from '@repo/temporal/src/workflows';

// Get Temporal client
const client = await getTemporalClient();

// Start workflow
const handle = await client.workflow.start(chatTitleGenerationWorkflow, {
  taskQueue: 'ai-chat',
  workflowId: `title-${chatId}`,
  args: [{
    chatId: 'chat-123',
    firstMessage: 'What is the meaning of life?',
    userId: 'user-456',
  }],
  workflowExecutionTimeout: '5m',
});

console.log(`Started workflow: ${handle.workflowId}`);
```

### Querying Workflow Status

```typescript
import { getTemporalClient } from '@repo/temporal';

const client = await getTemporalClient();
const handle = client.workflow.getHandle(workflowId);
const description = await handle.describe();

console.log(`Status: ${description.status.name}`);
console.log(`Start time: ${description.startTime}`);
console.log(`History length: ${description.historyLength}`);
```

### Using oRPC Procedures

The package provides oRPC procedures for workflow management:

```typescript
// Start title generation workflow
const result = await orpcClient.ai.chats.workflows.generateTitle({
  chatId: 'chat-123',
  firstMessage: 'Hello world',
});

// Get workflow status
const status = await orpcClient.ai.chats.workflows.getStatus({
  workflowId: result.workflowId,
});
```

## Current Workflows

### ChatTitleGenerationWorkflow

Generates a chat title using AI with automatic retries.

**Input:**
```typescript
{
  chatId: string;
  firstMessage: string;
  userId: string;
}
```

**Features:**
- Automatic retry on AI API failures (5 attempts)
- Exponential backoff (1s, 2s, 4s, 8s, 16s)
- Fallback to truncated message on persistent failures
- Database updates with retry logic
- Workflow status tracking

**Activities:**
1. `generateTitle` - Call AI API to generate title
2. `updateChatTitle` - Save title to database
3. `updateWorkflowStatus` - Update workflow status

## Development

### Adding a New Workflow

1. **Define Workflow** in `src/workflows/`:

```typescript
// src/workflows/my-workflow.ts
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { myActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: {
    initialInterval: '1s',
    maximumInterval: '30s',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

export async function myWorkflow(input: MyInput): Promise<MyOutput> {
  const result = await myActivity(input);
  return { success: true, result };
}
```

2. **Implement Activities** in `src/activities/`:

```typescript
// src/activities/my-activities.ts
export async function myActivity(input: MyInput): Promise<string> {
  // Non-deterministic operations (API calls, database writes, etc.)
  return "result";
}
```

3. **Export from index files**:

```typescript
// src/workflows/index.ts
export * from './my-workflow';

// src/activities/index.ts
export * from './my-activities';
```

4. **Create oRPC Procedure** in `packages/api/modules/`:

```typescript
export const startMyWorkflow = protectedProcedure
  .handler(async ({ input, context }) => {
    const client = await getTemporalClient();
    const handle = await client.workflow.start(myWorkflow, {
      taskQueue: 'ai-chat',
      workflowId: `my-${input.id}`,
      args: [input],
    });
    return { workflowId: handle.workflowId };
  });
```

### Testing

Run tests with:

```bash
pnpm --filter @repo/temporal test
```

Tests use Temporal's testing framework which doesn't require a running server.

### Debugging

1. **Temporal Web UI**: http://localhost:8233
   - View all workflows
   - See execution history
   - Inspect workflow state
   - View activity logs

2. **Worker Logs**: Check worker console output for activity execution logs

3. **Workflow History**: Query workflow execution history:

```typescript
const handle = client.workflow.getHandle(workflowId);
const history = await handle.fetchHistory();
console.log(history.events);
```

## Weave / CodingRun Lifecycle Contract

Any workflow that creates a Weave/CodingRun control-plane session
(currently `orchestratorExecutionWorkflow` and `codingRunWorkflow`) MUST
follow this contract or sessions will leak after force-terminations,
worker crashes, or unhandled throws:

1. **Wrap the body in `try { … } finally { … }`** and call
   `cleanupWeaveResourcesActivity` from the finally block. Run it inside
   `CancellationScope.nonCancellable(async () => { … })` so the activity
   still executes when Temporal cancels the outer scope.
2. **Set `workflowExecutionTimeout`** at start (read from
   `WEAVE_MAX_RUN_MINUTES` / `CODING_RUN_MAX_MINUTES`, default 120m).
   This is the hard ceiling — when exceeded, Temporal force-terminates
   the workflow and the finally does NOT run.
3. **Persist the workflowId and `startedAt`** on the owning DB row
   (`WeaveExecution.workflowId` / `CodingRun.workflowId` +
   `CodingRun.startedAt`). The watchdog scans on these.
4. **Track exit reason locally.** Initialise `let exitReason =
   "exception"` at the top, set it (`"success" | "failure" |
   "cancelled" | "oauth_blocked" | "timeout"`) at each early-return
   site, and pass it through to the cleanup activity for audit
   correlation.
5. **`weave-execution-watchdog`** is the safety net. It runs every 5
   min on the `fabric-worker` queue, finds non-terminal rows older than
   the ceiling, force-terminates them, calls the provider cleanup, and
   marks the row `TERMINATED_STALE` with a
   `weave.session.terminated_stale` audit-log entry.

Replay-determinism rules apply: never call `recordAudit` directly from
workflow code (audit writes happen inside activities), never use
`unsafe.now()` (use `Date.now()` only), and `Object.entries(...)`
order must be stable across replays.

## Production Deployment

### Option 1: Temporal Cloud (Recommended)

1. Sign up at https://temporal.io/cloud
2. Create a namespace
3. Choose an authentication method:

**API Key Authentication (Recommended):**
```bash
TEMPORAL_ADDRESS="your-namespace.tmprl.cloud:7233"
TEMPORAL_NAMESPACE="your-namespace"
TEMPORAL_CLOUD_API_KEY="your-api-key"
# Note: TLS is automatically enabled when using API key
```

**mTLS Certificate Authentication (Alternative):**
```bash
TEMPORAL_ADDRESS="your-namespace.tmprl.cloud:7233"
TEMPORAL_NAMESPACE="your-namespace"
TEMPORAL_TLS="true"
TEMPORAL_CLIENT_CERT="<base64-encoded-certificate>"
TEMPORAL_CLIENT_KEY="<base64-encoded-private-key>"
```

### Option 2: Self-Hosted

1. Deploy Temporal Server (Kubernetes recommended)
2. Configure PostgreSQL or Cassandra for persistence
3. Set up monitoring (Prometheus + Grafana)
4. Deploy workers as separate services

### Worker Deployment

Workers should be deployed as separate processes:

```dockerfile
# Dockerfile for worker
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN pnpm install
CMD ["pnpm", "--filter", "@repo/temporal", "worker"]
```

Deploy multiple worker instances for redundancy and scaling.

## Monitoring

### Metrics

Temporal provides built-in metrics:
- Workflow success/failure rates
- Activity execution times
- Queue depths
- Worker health

### Alerts

Set up alerts for:
- Workflow failures
- High queue depths
- Worker disconnections
- Long-running workflows

## Troubleshooting

### Worker Not Connecting

```bash
# Check Temporal Server is running
docker-compose ps temporal

# Check worker logs
pnpm --filter @repo/temporal worker

# Verify environment variables
echo $TEMPORAL_ADDRESS
```

### Workflow Not Starting

1. Check feature flag: `ENABLE_TEMPORAL_WORKFLOWS="true"`
2. Verify Temporal Server is accessible
3. Check worker is running and polling correct task queue
4. Review API logs for errors

### Activity Failures

1. Check activity logs in worker console
2. View workflow history in Temporal Web UI
3. Verify retry policy configuration
4. Check for transient vs persistent failures

## Resources

- [Temporal Documentation](https://docs.temporal.io/)
- [TypeScript SDK](https://typescript.temporal.io/)
- [Best Practices](https://docs.temporal.io/dev-guide/typescript/best-practices)
- [Temporal Cloud](https://temporal.io/cloud)

## Future Enhancements

Potential workflows to add:

1. **ChatMessageWorkflow**: Full message exchange with streaming
2. **BatchTitleGenerationWorkflow**: Regenerate titles for all chats
3. **ChatExportWorkflow**: Export conversations to file
4. **AIAgentWorkflow**: Multi-step AI agent operations
5. **ContentModerationWorkflow**: Async content moderation


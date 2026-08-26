# Durable Agent Deployment Architecture

## Executive Summary

This document outlines the architecture for making agent template instances into durable, long-running, deployable agents that support:
- **Multi-tenancy**: Both personal accounts and organizational accounts
- **High concurrency**: Hundreds to thousands of simultaneous executions
- **Durability**: Fault-tolerant execution with automatic recovery
- **Extensibility**: Easy to add new agent types and capabilities

---

## Current State Analysis

### What Exists Today

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CURRENT ARCHITECTURE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  AgentTemplate (23 types)                                                   │
│       │                                                                     │
│       ▼                                                                     │
│  AgentTemplateInstance (user's customization)                               │
│       │                                                                     │
│       ▼                                                                     │
│  Manual Execution via Orchestrator API                                      │
│       │                                                                     │
│       ▼                                                                     │
│  Temporal Orchestrator Workflow (single queue, ~70 concurrent max)          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Identified Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| **No deployment abstraction** | Instances are just config records | Can't treat agents as running services |
| **Single worker process** | ~70 concurrent executions max | Can't scale to 1000s |
| **Fixed task queues** | 7 static queues | No org isolation or priority |
| **No trigger activation** | Triggers defined but not wired | Webhook/Slack/Schedule don't work |
| **No lifecycle management** | No deploy/pause/resume | Can't manage agent state |
| **No tenant sharding** | All orgs share same queues | Head-of-line blocking |

---

## Target Architecture

### High-Level Design

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                           DURABLE AGENT DEPLOYMENT ARCHITECTURE                       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────────┐                 │
│  │   Template  │───▶│ Template Instance│───▶│  Agent Deployment   │                 │
│  │  (Config)   │    │ (User Config)    │    │  (Running Service)  │                 │
│  └─────────────┘    └──────────────────┘    └──────────┬──────────┘                 │
│                                                        │                            │
│                     ┌──────────────────────────────────┼──────────────────────┐     │
│                     │                                  │                      │     │
│                     ▼                                  ▼                      ▼     │
│  ┌──────────────────────────┐    ┌──────────────────────────┐    ┌─────────────┐   │
│  │   Supervisor Workflow    │    │    Trigger Gateway       │    │  Health     │   │
│  │   (Per Deployment)       │    │                          │    │  Monitor    │   │
│  │   ┌─────────────────┐    │    │  ┌────────┐ ┌────────┐  │    │             │   │
│  │   │ Agent State     │    │    │  │Webhook │ │ Slack  │  │    │  Heartbeat  │   │
│  │   │ Execution Queue │    │    │  └────────┘ └────────┘  │    │  Activity   │   │
│  │   │ Rate Limiter    │    │    │  ┌────────┐ ┌────────┐  │    │             │   │
│  │   └─────────────────┘    │    │  │Schedule│ │ Email  │  │    └─────────────┘   │
│  └──────────────────────────┘    │  └────────┘ └────────┘  │                      │
│              │                    └──────────────────────────┘                      │
│              │                                                                      │
│              ▼                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                         SHARDED TASK QUEUES                                   │  │
│  │                                                                               │  │
│  │   Personal: agents-personal-{hash}    Org: agents-org-{orgId}-{shard}        │  │
│  │                                                                               │  │
│  │   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │   │ Shard 0  │ │ Shard 1  │ │ Shard 2  │ │ Priority │ │ Batch    │          │  │
│  │   │ Workers  │ │ Workers  │ │ Workers  │ │ Workers  │ │ Workers  │          │  │
│  │   └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘          │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### New Models

```prisma
// =============================================================================
// AGENT DEPLOYMENT - Running instance of an agent
// =============================================================================
model AgentDeployment {
  id             String  @id @default(cuid())
  instanceId     String  @unique
  userId         String
  organizationId String?

  // Deployment identification
  name           String
  slug           String  // URL-friendly identifier

  // Deployment state
  status         DeploymentStatus @default(PENDING)
  deployedAt     DateTime?
  pausedAt       DateTime?
  terminatedAt   DateTime?
  lastActiveAt   DateTime?

  // Temporal workflow management
  supervisorWorkflowId  String?   // Long-running supervisor workflow
  supervisorRunId       String?

  // Task queue assignment (for sharding)
  taskQueue      String?          // e.g., "agents-org-abc123-shard-0"

  // Health & monitoring
  healthStatus   HealthStatus @default(UNKNOWN)
  lastHealthCheck DateTime?
  consecutiveFailures Int @default(0)

  // Concurrency control
  maxConcurrentExecutions Int @default(5)
  currentExecutions       Int @default(0)

  // Rate limiting (per deployment)
  rateLimitPerMinute  Int @default(60)
  rateLimitPerHour    Int @default(500)

  // Active trigger configurations
  activeTriggers  Json @default("[]")  // Activated triggers from instance

  // Resource quotas
  dailyExecutionLimit   Int?   // null = unlimited
  monthlyExecutionLimit Int?
  dailyExecutionCount   Int @default(0)
  monthlyExecutionCount Int @default(0)
  quotaResetAt          DateTime?

  // Metadata
  version        Int @default(1)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // Relations
  instance       AgentTemplateInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  user           User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization   Organization?         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  executions     AgentDeploymentExecution[]
  triggers       AgentDeploymentTrigger[]
  metrics        AgentDeploymentMetrics[]

  @@unique([organizationId, slug])
  @@unique([userId, slug, organizationId])  // Personal scope unique
  @@index([status])
  @@index([taskQueue])
  @@index([healthStatus])
  @@index([userId])
  @@index([organizationId])
  @@map("agent_deployment")
}

enum DeploymentStatus {
  PENDING      // Deployment requested, supervisor not started
  DEPLOYING    // Starting supervisor workflow
  ACTIVE       // Running, accepting executions
  PAUSED       // Temporarily stopped, supervisor sleeping
  DEGRADED     // Running but unhealthy
  FAILED       // Deployment failed, needs manual intervention
  TERMINATED   // Permanently stopped
}

enum HealthStatus {
  UNKNOWN
  HEALTHY
  DEGRADED
  UNHEALTHY
}

// =============================================================================
// AGENT DEPLOYMENT EXECUTION - Individual execution record
// =============================================================================
model AgentDeploymentExecution {
  id             String  @id @default(cuid())
  deploymentId   String
  userId         String
  organizationId String?

  // Execution identification
  executionId    String @unique  // Temporal workflow execution ID

  // Trigger information
  triggerType    String           // "manual", "webhook", "slack", "schedule", "api"
  triggerId      String?          // Reference to specific trigger
  triggerData    Json?            // Data from the trigger

  // Status tracking
  status         ExecutionStatus @default(PENDING)
  queuedAt       DateTime @default(now())
  startedAt      DateTime?
  completedAt    DateTime?
  duration       Int?             // milliseconds

  // Priority (for queue ordering)
  priority       Int @default(5)  // 1 (highest) to 10 (lowest)

  // Input/Output
  input          Json?
  output         Json?
  error          String? @db.Text

  // Temporal tracking
  workflowId     String?
  runId          String?

  // Token usage
  inputTokens    Int @default(0)
  outputTokens   Int @default(0)
  totalCost      Decimal? @db.Decimal(10, 6)

  // Metadata
  metadata       Json?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // Relations
  deployment     AgentDeployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  steps          AgentExecutionStep[]

  @@index([deploymentId])
  @@index([status])
  @@index([triggerType])
  @@index([priority])
  @@index([queuedAt])
  @@index([userId])
  @@index([organizationId])
  @@map("agent_deployment_execution")
}

enum ExecutionStatus {
  PENDING        // Queued, waiting to start
  RUNNING        // Currently executing
  WAITING_INPUT  // Waiting for user input (HITL)
  COMPLETED      // Successfully completed
  FAILED         // Failed with error
  CANCELLED      // Cancelled by user
  TIMED_OUT      // Exceeded timeout
}

// =============================================================================
// AGENT EXECUTION STEP - Individual step within an execution
// =============================================================================
model AgentExecutionStep {
  id           String @id @default(cuid())
  executionId  String

  // Step identification
  stepNumber   Int
  stepType     String   // "planning", "tool_call", "llm_call", "approval", etc.

  // Step details
  name         String?
  description  String?

  // Timing
  startedAt    DateTime?
  completedAt  DateTime?
  duration     Int?

  // Input/Output
  input        Json?
  output       Json?
  error        String?

  // Status
  status       String @default("pending")  // pending, running, completed, failed, skipped

  createdAt    DateTime @default(now())

  // Relations
  execution    AgentDeploymentExecution @relation(fields: [executionId], references: [id], onDelete: Cascade)

  @@index([executionId])
  @@index([stepType])
  @@map("agent_execution_step")
}

// =============================================================================
// AGENT DEPLOYMENT TRIGGER - Activated trigger for a deployment
// =============================================================================
model AgentDeploymentTrigger {
  id             String  @id @default(cuid())
  deploymentId   String

  // Trigger type
  type           TriggerType

  // Trigger configuration (type-specific)
  config         Json

  // Webhook-specific
  webhookSecret  String?  // Secret for validating webhook signatures
  webhookUrl     String?  // Generated URL for this trigger

  // Schedule-specific
  cronExpression String?
  timezone       String?
  nextRunAt      DateTime?
  lastRunAt      DateTime?

  // Slack-specific
  slackChannelId String?
  slackTeamId    String?

  // Status
  isActive       Boolean @default(true)

  // Execution tracking
  totalExecutions Int @default(0)
  lastExecutionId String?

  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // Relations
  deployment     AgentDeployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)

  @@unique([deploymentId, type, slackChannelId])  // One trigger per type per context
  @@index([type])
  @@index([isActive])
  @@index([nextRunAt])
  @@map("agent_deployment_trigger")
}

enum TriggerType {
  MANUAL
  WEBHOOK
  SLACK
  SCHEDULE
  EMAIL
  API
}

// =============================================================================
// AGENT DEPLOYMENT METRICS - Aggregated metrics per deployment
// =============================================================================
model AgentDeploymentMetrics {
  id             String   @id @default(cuid())
  deploymentId   String

  // Time window
  windowStart    DateTime
  windowEnd      DateTime
  windowType     String   // "hourly", "daily", "weekly", "monthly"

  // Execution metrics
  totalExecutions       Int @default(0)
  successfulExecutions  Int @default(0)
  failedExecutions      Int @default(0)
  cancelledExecutions   Int @default(0)
  timedOutExecutions    Int @default(0)

  // Performance metrics
  avgDurationMs         Int?
  p50DurationMs         Int?
  p95DurationMs         Int?
  p99DurationMs         Int?

  // Token usage
  totalInputTokens      Int @default(0)
  totalOutputTokens     Int @default(0)
  totalCost             Decimal? @db.Decimal(10, 6)

  // Trigger breakdown
  executionsByTrigger   Json @default("{}")  // { "webhook": 100, "slack": 50, ... }

  createdAt             DateTime @default(now())

  // Relations
  deployment            AgentDeployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)

  @@unique([deploymentId, windowStart, windowType])
  @@index([deploymentId])
  @@index([windowStart])
  @@map("agent_deployment_metrics")
}

// =============================================================================
// TASK QUEUE SHARD - Dynamic task queue management
// =============================================================================
model TaskQueueShard {
  id             String  @id @default(cuid())

  // Queue identification
  queueName      String  @unique
  shardType      String  // "personal", "organization", "priority", "batch"

  // Ownership (for org shards)
  organizationId String?

  // Capacity tracking
  currentDepth   Int @default(0)
  maxDepth       Int @default(1000)

  // Worker tracking
  activeWorkers  Int @default(0)
  targetWorkers  Int @default(2)

  // Health
  isHealthy      Boolean @default(true)
  lastHealthCheck DateTime?

  // Metrics
  totalProcessed Int @default(0)
  avgLatencyMs   Int?

  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([shardType])
  @@index([organizationId])
  @@index([isHealthy])
  @@map("task_queue_shard")
}

// =============================================================================
// ORGANIZATION DEPLOYMENT QUOTA - Per-org deployment limits
// =============================================================================
model OrganizationDeploymentQuota {
  id                    String @id @default(cuid())
  organizationId        String @unique

  // Deployment limits
  maxDeployments        Int @default(10)
  maxConcurrentExecutions Int @default(50)

  // Execution limits
  dailyExecutionLimit   Int @default(1000)
  monthlyExecutionLimit Int @default(20000)

  // Current usage
  currentDeployments    Int @default(0)
  dailyExecutionCount   Int @default(0)
  monthlyExecutionCount Int @default(0)

  // Reset tracking
  dailyResetAt          DateTime?
  monthlyResetAt        DateTime?

  // Custom limits (for enterprise)
  customLimits          Json?

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  // Relations
  organization          Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("organization_deployment_quota")
}

// =============================================================================
// USER DEPLOYMENT QUOTA - Per-user deployment limits (personal accounts)
// =============================================================================
model UserDeploymentQuota {
  id                    String @id @default(cuid())
  userId                String @unique

  // Deployment limits
  maxDeployments        Int @default(3)
  maxConcurrentExecutions Int @default(10)

  // Execution limits
  dailyExecutionLimit   Int @default(100)
  monthlyExecutionLimit Int @default(2000)

  // Current usage
  currentDeployments    Int @default(0)
  dailyExecutionCount   Int @default(0)
  monthlyExecutionCount Int @default(0)

  // Reset tracking
  dailyResetAt          DateTime?
  monthlyResetAt        DateTime?

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  // Relations
  user                  User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_deployment_quota")
}
```

---

## Temporal Workflow Architecture

### Supervisor Workflow (Long-Running)

```typescript
// packages/temporal/src/workflows/agent-supervisor.ts

import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";

// =============================================================================
// TYPES
// =============================================================================

export interface SupervisorWorkflowInput {
  deploymentId: string;
  instanceId: string;
  userId: string;
  organizationId?: string;
  config: DeploymentConfig;
}

export interface DeploymentConfig {
  maxConcurrentExecutions: number;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  healthCheckIntervalMs: number;
  executionTimeoutMs: number;
}

interface SupervisorState {
  deploymentId: string;
  status: "active" | "paused" | "terminating";
  currentExecutions: Map<string, ExecutionInfo>;
  pendingExecutions: ExecutionRequest[];
  healthStatus: "healthy" | "degraded" | "unhealthy";
  lastHealthCheck: string;
  metrics: {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
  };
  // Continue-as-new tracking
  executionsSinceReset: number;
  startTime: number;
}

interface ExecutionRequest {
  executionId: string;
  input: Record<string, any>;
  triggerType: string;
  triggerId?: string;
  priority: number;
  queuedAt: string;
}

interface ExecutionInfo {
  executionId: string;
  workflowId: string;
  startedAt: string;
  status: "running" | "completing";
}

// =============================================================================
// SIGNALS
// =============================================================================

export const executeSignal = defineSignal<[ExecutionRequest]>("execute");
export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const terminateSignal = defineSignal("terminate");
export const cancelExecutionSignal = defineSignal<[{ executionId: string }]>("cancelExecution");

// =============================================================================
// QUERIES
// =============================================================================

export const statusQuery = defineQuery<SupervisorState["status"]>("status");
export const healthQuery = defineQuery<SupervisorState["healthStatus"]>("health");
export const metricsQuery = defineQuery<SupervisorState["metrics"]>("metrics");
export const currentExecutionsQuery = defineQuery<number>("currentExecutions");
export const pendingExecutionsQuery = defineQuery<number>("pendingExecutions");

// =============================================================================
// ACTIVITIES
// =============================================================================

const activities = proxyActivities<typeof import("../activities/agent-supervisor")>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    maximumAttempts: 3,
  },
});

const longRunningActivities = proxyActivities<typeof import("../activities/agent-supervisor")>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "30s",
  retry: {
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
    maximumAttempts: 2,
  },
});

// =============================================================================
// WORKFLOW IMPLEMENTATION
// =============================================================================

/**
 * Agent Supervisor Workflow
 *
 * Long-running workflow that manages a single agent deployment.
 * Handles:
 * - Execution queue management
 * - Concurrency control
 * - Health monitoring
 * - Lifecycle (pause/resume/terminate)
 *
 * Uses continue-as-new to prevent workflow history explosion.
 */
export async function agentSupervisorWorkflow(
  input: SupervisorWorkflowInput,
): Promise<void> {
  const { deploymentId, config } = input;

  // Initialize state
  const state: SupervisorState = {
    deploymentId,
    status: "active",
    currentExecutions: new Map(),
    pendingExecutions: [],
    healthStatus: "healthy",
    lastHealthCheck: new Date().toISOString(),
    metrics: {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
    },
    executionsSinceReset: 0,
    startTime: Date.now(),
  };

  // ==========================================================================
  // Signal Handlers
  // ==========================================================================

  setHandler(executeSignal, (request) => {
    log.info("Received execution request", { executionId: request.executionId });

    // Add to pending queue (sorted by priority)
    state.pendingExecutions.push(request);
    state.pendingExecutions.sort((a, b) => a.priority - b.priority);
  });

  setHandler(pauseSignal, () => {
    log.info("Received pause signal");
    state.status = "paused";
  });

  setHandler(resumeSignal, () => {
    log.info("Received resume signal");
    state.status = "active";
  });

  setHandler(terminateSignal, () => {
    log.info("Received terminate signal");
    state.status = "terminating";
  });

  setHandler(cancelExecutionSignal, ({ executionId }) => {
    log.info("Received cancel execution signal", { executionId });
    // Remove from pending if present
    state.pendingExecutions = state.pendingExecutions.filter(
      (e) => e.executionId !== executionId
    );
    // Mark running execution for cancellation
    const running = state.currentExecutions.get(executionId);
    if (running) {
      running.status = "completing";
    }
  });

  // ==========================================================================
  // Query Handlers
  // ==========================================================================

  setHandler(statusQuery, () => state.status);
  setHandler(healthQuery, () => state.healthStatus);
  setHandler(metricsQuery, () => state.metrics);
  setHandler(currentExecutionsQuery, () => state.currentExecutions.size);
  setHandler(pendingExecutionsQuery, () => state.pendingExecutions.length);

  // ==========================================================================
  // Main Loop
  // ==========================================================================

  log.info("Starting agent supervisor", { deploymentId });

  // Update deployment status to ACTIVE
  await activities.updateDeploymentStatus({
    deploymentId,
    status: "ACTIVE",
  });

  while (state.status !== "terminating") {
    // Check for continue-as-new condition
    if (shouldContinueAsNew(state)) {
      log.info("Continuing as new to prevent history growth");
      await continueAsNew<typeof agentSupervisorWorkflow>(input);
    }

    // Handle paused state
    if (state.status === "paused") {
      await activities.updateDeploymentStatus({
        deploymentId,
        status: "PAUSED",
      });

      // Wait for resume signal
      await condition(() => state.status !== "paused");

      await activities.updateDeploymentStatus({
        deploymentId,
        status: "ACTIVE",
      });
      continue;
    }

    // Process pending executions (respecting concurrency limit)
    while (
      state.pendingExecutions.length > 0 &&
      state.currentExecutions.size < config.maxConcurrentExecutions
    ) {
      const request = state.pendingExecutions.shift()!;
      await startExecution(state, input, request);
    }

    // Health check (every healthCheckIntervalMs)
    const timeSinceHealthCheck = Date.now() - new Date(state.lastHealthCheck).getTime();
    if (timeSinceHealthCheck > config.healthCheckIntervalMs) {
      await performHealthCheck(state, deploymentId);
    }

    // Wait for signals or timeout (polling interval)
    await condition(
      () =>
        state.pendingExecutions.length > 0 ||
        state.status !== "active",
      5000 // 5 second poll interval
    );

    state.executionsSinceReset++;
  }

  // ==========================================================================
  // Termination Cleanup
  // ==========================================================================

  log.info("Terminating supervisor", { deploymentId });

  // Cancel all pending executions
  for (const pending of state.pendingExecutions) {
    await activities.cancelPendingExecution({
      executionId: pending.executionId,
      reason: "Deployment terminated",
    });
  }

  // Wait for running executions to complete (with timeout)
  await condition(
    () => state.currentExecutions.size === 0,
    60000 // 1 minute timeout
  );

  // Update deployment status to TERMINATED
  await activities.updateDeploymentStatus({
    deploymentId,
    status: "TERMINATED",
  });

  log.info("Supervisor terminated", { deploymentId });
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function startExecution(
  state: SupervisorState,
  input: SupervisorWorkflowInput,
  request: ExecutionRequest,
): Promise<void> {
  const { deploymentId, instanceId, userId, organizationId, config } = input;

  log.info("Starting execution", { executionId: request.executionId });

  try {
    // Start child workflow for execution
    const workflowId = `agent-exec-${request.executionId}`;

    await longRunningActivities.startAgentExecution({
      workflowId,
      deploymentId,
      instanceId,
      executionId: request.executionId,
      userId,
      organizationId,
      input: request.input,
      triggerType: request.triggerType,
      triggerId: request.triggerId,
      timeoutMs: config.executionTimeoutMs,
    });

    // Track in current executions
    state.currentExecutions.set(request.executionId, {
      executionId: request.executionId,
      workflowId,
      startedAt: new Date().toISOString(),
      status: "running",
    });

    state.metrics.totalExecutions++;
  } catch (error) {
    log.error("Failed to start execution", {
      executionId: request.executionId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    state.metrics.failedExecutions++;
  }
}

async function performHealthCheck(
  state: SupervisorState,
  deploymentId: string,
): Promise<void> {
  try {
    const health = await activities.checkDeploymentHealth({ deploymentId });
    state.healthStatus = health.status;
    state.lastHealthCheck = new Date().toISOString();

    // Update deployment health status
    await activities.updateDeploymentHealth({
      deploymentId,
      healthStatus: health.status,
      lastHealthCheck: state.lastHealthCheck,
    });
  } catch (error) {
    log.warn("Health check failed", { error });
    state.healthStatus = "degraded";
  }
}

function shouldContinueAsNew(state: SupervisorState): boolean {
  // Continue-as-new after 1000 executions or 1 hour
  const MAX_EXECUTIONS = 1000;
  const MAX_DURATION_MS = 60 * 60 * 1000; // 1 hour

  return (
    state.executionsSinceReset >= MAX_EXECUTIONS ||
    Date.now() - state.startTime >= MAX_DURATION_MS
  );
}
```

### Execution Workflow

```typescript
// packages/temporal/src/workflows/agent-execution.ts

/**
 * Agent Execution Workflow
 *
 * Executes a single agent task with full durability.
 * Child workflow of the supervisor.
 */
export async function agentExecutionWorkflow(
  input: AgentExecutionInput,
): Promise<AgentExecutionOutput> {
  const { deploymentId, instanceId, executionId, userId, organizationId } = input;

  // Initialize execution record
  await activities.initializeExecution({
    executionId,
    deploymentId,
    userId,
    organizationId,
    input: input.input,
    triggerType: input.triggerType,
  });

  try {
    // Load agent configuration
    const agentConfig = await activities.loadAgentConfig({
      instanceId,
      userId,
      organizationId,
    });

    // Execute via orchestrator (reuse existing infrastructure)
    const result = await longRunningActivities.executeViaOrchestrator({
      executionId,
      agentConfig,
      input: input.input,
      userId,
      organizationId,
      timeoutMs: input.timeoutMs,
    });

    // Record success
    await activities.completeExecution({
      executionId,
      status: "COMPLETED",
      output: result.output,
      tokenUsage: result.tokenUsage,
    });

    return {
      executionId,
      status: "COMPLETED",
      output: result.output,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Record failure
    await activities.completeExecution({
      executionId,
      status: "FAILED",
      error: errorMessage,
    });

    return {
      executionId,
      status: "FAILED",
      error: errorMessage,
    };
  }
}
```

---

## Task Queue Sharding Strategy

### Sharding Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         TASK QUEUE SHARDING                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PERSONAL ACCOUNTS                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  agents-personal-shard-0  │  agents-personal-shard-1  │  ...shard-N │    │
│  │  (hash(userId) % N)       │                           │              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ORGANIZATION ACCOUNTS (Dedicated per org if high volume)                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  agents-org-{orgId}-shard-0  │  agents-org-{orgId}-shard-1  │ ...   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  SHARED ORGANIZATION POOL (for low-volume orgs)                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  agents-org-shared-shard-0  │  agents-org-shared-shard-1  │  ...    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  PRIORITY QUEUES                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  agents-priority-critical  │  agents-priority-high  │  agents-batch │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Queue Selection Algorithm

```typescript
// packages/temporal/src/lib/queue-selector.ts

interface QueueSelectionInput {
  userId: string;
  organizationId?: string;
  priority: number;
  estimatedDurationMs: number;
}

interface QueueSelectionResult {
  taskQueue: string;
  shardType: "personal" | "organization-dedicated" | "organization-shared" | "priority";
}

const PERSONAL_SHARD_COUNT = 5;
const ORG_SHARED_SHARD_COUNT = 10;
const ORG_DEDICATED_THRESHOLD = 100; // Executions per day to get dedicated queue

export async function selectTaskQueue(
  input: QueueSelectionInput,
): Promise<QueueSelectionResult> {
  const { userId, organizationId, priority, estimatedDurationMs } = input;

  // Priority override for critical tasks
  if (priority <= 2) {
    return {
      taskQueue: "agents-priority-critical",
      shardType: "priority",
    };
  }

  // Batch processing for low-priority, long-running tasks
  if (priority >= 8 && estimatedDurationMs > 300000) { // > 5 min
    return {
      taskQueue: "agents-batch",
      shardType: "priority",
    };
  }

  // Organization context
  if (organizationId) {
    const orgUsage = await getOrganizationDailyUsage(organizationId);

    // Dedicated queues for high-volume orgs
    if (orgUsage >= ORG_DEDICATED_THRESHOLD) {
      const shardNumber = hashCode(organizationId) % 3; // 3 shards per dedicated org
      return {
        taskQueue: `agents-org-${organizationId}-shard-${shardNumber}`,
        shardType: "organization-dedicated",
      };
    }

    // Shared pool for low-volume orgs
    const shardNumber = hashCode(organizationId) % ORG_SHARED_SHARD_COUNT;
    return {
      taskQueue: `agents-org-shared-shard-${shardNumber}`,
      shardType: "organization-shared",
    };
  }

  // Personal accounts
  const shardNumber = hashCode(userId) % PERSONAL_SHARD_COUNT;
  return {
    taskQueue: `agents-personal-shard-${shardNumber}`,
    shardType: "personal",
  };
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
```

---

## Worker Scaling Architecture

### Worker Configuration

```typescript
// packages/temporal/src/workers/agent-workers.ts

import { Worker, NativeConnection } from "@temporalio/worker";

interface WorkerConfig {
  taskQueue: string;
  maxConcurrentActivities: number;
  maxConcurrentWorkflows: number;
}

// Worker configurations optimized for different workloads
const WORKER_CONFIGS: Record<string, WorkerConfig> = {
  // Personal account shards (lower concurrency, fair distribution)
  "agents-personal": {
    taskQueue: "agents-personal-shard-*",
    maxConcurrentActivities: 20,
    maxConcurrentWorkflows: 10,
  },

  // Organization shared pool (medium concurrency)
  "agents-org-shared": {
    taskQueue: "agents-org-shared-shard-*",
    maxConcurrentActivities: 30,
    maxConcurrentWorkflows: 15,
  },

  // Organization dedicated (high concurrency for single org)
  "agents-org-dedicated": {
    taskQueue: "agents-org-*",
    maxConcurrentActivities: 50,
    maxConcurrentWorkflows: 20,
  },

  // Priority queue (fast execution)
  "agents-priority": {
    taskQueue: "agents-priority-*",
    maxConcurrentActivities: 40,
    maxConcurrentWorkflows: 20,
  },

  // Batch processing (high throughput, tolerant of latency)
  "agents-batch": {
    taskQueue: "agents-batch",
    maxConcurrentActivities: 100,
    maxConcurrentWorkflows: 50,
  },
};

/**
 * Start workers for agent execution
 *
 * In production, run multiple instances per queue type for redundancy.
 */
export async function startAgentWorkers(
  connection: NativeConnection,
  queuePattern: string,
): Promise<Worker[]> {
  const workers: Worker[] = [];

  // Find matching configurations
  const configs = Object.entries(WORKER_CONFIGS)
    .filter(([pattern]) => queuePattern.includes(pattern) || pattern.includes(queuePattern));

  for (const [name, config] of configs) {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE || "default",
      taskQueue: config.taskQueue,
      workflowsPath: require.resolve("../workflows"),
      activities: require("../activities"),
      maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
      maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflows,
      // Enable sticky queues for better performance
      stickyQueueScheduleToStartTimeout: "10s",
    });

    workers.push(worker);
    console.log(`Started worker for ${name}: ${config.taskQueue}`);
  }

  return workers;
}
```

### Kubernetes Deployment

```yaml
# k8s/deployments/agent-workers.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-worker-personal
spec:
  replicas: 5  # 5 workers for personal queues
  selector:
    matchLabels:
      app: agent-worker
      queue-type: personal
  template:
    spec:
      containers:
      - name: worker
        image: fabric/temporal-worker:latest
        env:
        - name: WORKER_TYPE
          value: "agents-personal"
        - name: TEMPORAL_TASK_QUEUE
          value: "agents-personal-shard-*"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-worker-org-shared
spec:
  replicas: 10  # 10 workers for shared org pool
  selector:
    matchLabels:
      app: agent-worker
      queue-type: org-shared
  template:
    spec:
      containers:
      - name: worker
        image: fabric/temporal-worker:latest
        env:
        - name: WORKER_TYPE
          value: "agents-org-shared"
        - name: TEMPORAL_TASK_QUEUE
          value: "agents-org-shared-shard-*"
        resources:
          requests:
            memory: "1Gi"
            cpu: "1000m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: agent-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: agent-worker-org-shared
  minReplicas: 5
  maxReplicas: 50
  metrics:
  - type: External
    external:
      metric:
        name: temporal_task_queue_depth
        selector:
          matchLabels:
            queue: agents-org-shared
      target:
        type: AverageValue
        averageValue: "100"  # Scale when >100 pending tasks
```

---

## API Design

### Deployment API

```typescript
// packages/api/modules/agent-deployments/router.ts

export const agentDeploymentsRouter = router({
  // Deploy an agent instance
  deploy: protectedProcedure
    .input(z.object({
      instanceId: z.string(),
      organizationId: z.string().nullable().optional(),
      config: z.object({
        maxConcurrentExecutions: z.number().min(1).max(100).default(5),
        rateLimitPerMinute: z.number().min(1).max(1000).default(60),
        rateLimitPerHour: z.number().min(1).max(10000).default(500),
      }).optional(),
    }))
    .handler(async ({ input, context }) => {
      const userId = context.user.id;
      const organizationId = resolveOrganizationId(input.organizationId, context.session);

      // Check quota
      await checkDeploymentQuota(userId, organizationId);

      // Create deployment
      const deployment = await createAgentDeployment({
        instanceId: input.instanceId,
        userId,
        organizationId,
        config: input.config,
      });

      // Start supervisor workflow
      await startSupervisorWorkflow(deployment);

      return { deployment };
    }),

  // Get deployment status
  get: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      // ... tenant-scoped query
    }),

  // List deployments
  list: protectedProcedure
    .input(z.object({
      organizationId: z.string().nullable().optional(),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }))
    .handler(async ({ input, context }) => {
      // ... tenant-scoped list with filtering
    }),

  // Pause deployment
  pause: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      // Send pause signal to supervisor workflow
      await signalSupervisor(input.deploymentId, "pause");
      return { success: true };
    }),

  // Resume deployment
  resume: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      await signalSupervisor(input.deploymentId, "resume");
      return { success: true };
    }),

  // Terminate deployment
  terminate: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      await signalSupervisor(input.deploymentId, "terminate");
      return { success: true };
    }),

  // Execute agent (manual trigger)
  execute: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
      input: z.record(z.any()),
      priority: z.number().min(1).max(10).default(5),
    }))
    .handler(async ({ input, context }) => {
      const executionId = generateExecutionId();

      // Check rate limit
      await checkRateLimit(input.deploymentId);

      // Signal supervisor to execute
      await signalSupervisor(input.deploymentId, "execute", {
        executionId,
        input: input.input,
        triggerType: "manual",
        priority: input.priority,
        queuedAt: new Date().toISOString(),
      });

      return { executionId };
    }),

  // Get execution status
  getExecution: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      executionId: z.string(),
      organizationId: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      // ... return execution details
    }),

  // List executions
  listExecutions: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
      status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "ALL"]).default("ALL"),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }))
    .handler(async ({ input, context }) => {
      // ... tenant-scoped execution list
    }),

  // Get deployment metrics
  metrics: protectedProcedure
    .input(z.object({
      deploymentId: z.string(),
      organizationId: z.string().nullable().optional(),
      windowType: z.enum(["hourly", "daily", "weekly", "monthly"]).default("daily"),
      limit: z.number().min(1).max(90).default(7),
    }))
    .handler(async ({ input, context }) => {
      // ... return aggregated metrics
    }),
});
```

### Trigger API (Webhooks)

```typescript
// apps/web/app/api/webhooks/agent/[deploymentId]/route.ts

export async function POST(
  request: Request,
  { params }: { params: { deploymentId: string } },
) {
  const { deploymentId } = params;

  // Validate webhook signature
  const signature = request.headers.get("x-webhook-signature");
  const body = await request.text();

  const trigger = await validateWebhookTrigger(deploymentId, signature, body);
  if (!trigger) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse webhook payload
  const payload = JSON.parse(body);

  // Create execution request
  const executionId = generateExecutionId();

  await signalSupervisor(deploymentId, "execute", {
    executionId,
    input: payload,
    triggerType: "webhook",
    triggerId: trigger.id,
    priority: 5,
    queuedAt: new Date().toISOString(),
  });

  return NextResponse.json({ executionId });
}
```

---

## Scaling Capacity Planning

### Concurrency Calculations

| Component | Instances | Concurrency | Total Capacity |
|-----------|-----------|-------------|----------------|
| Personal Workers | 5 | 20 activities | 100 concurrent |
| Org Shared Workers | 10 | 30 activities | 300 concurrent |
| Org Dedicated Workers | 5 per high-volume org | 50 activities | 250 per org |
| Priority Workers | 5 | 40 activities | 200 concurrent |
| Batch Workers | 10 | 100 activities | 1000 concurrent |

**Total System Capacity: ~2000+ concurrent executions**

### Auto-Scaling Rules

```yaml
# Horizontal Pod Autoscaler rules

# Scale up when queue depth > 100 per worker
scale_up_threshold: 100

# Scale down when queue depth < 20 per worker
scale_down_threshold: 20

# Min/Max workers per queue type
personal:
  min: 3
  max: 20
org_shared:
  min: 5
  max: 50
org_dedicated:
  min: 2
  max: 20
batch:
  min: 5
  max: 100
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (2-3 weeks)
1. Database schema migration
2. Supervisor workflow implementation
3. Execution workflow integration
4. Basic deployment API
5. Manual execution trigger

### Phase 2: Multi-Tenancy & Quotas (1-2 weeks)
6. Tenant-scoped queries and filters
7. User/Org deployment quotas
8. Rate limiting per deployment
9. Quota enforcement in supervisor

### Phase 3: Trigger System (2 weeks)
10. Webhook trigger endpoint
11. Webhook signature validation
12. Schedule trigger (Temporal schedules)
13. Slack trigger integration

### Phase 4: Scaling & Sharding (2 weeks)
14. Task queue sharding implementation
15. Queue selection algorithm
16. Worker configuration by queue type
17. Health monitoring and alerting

### Phase 5: Production Readiness (1-2 weeks)
18. Kubernetes deployment manifests
19. HPA configuration
20. Metrics and observability
21. Load testing and tuning

---

## Monitoring & Observability

### Key Metrics

```typescript
// Deployment-level metrics
deployment_status{deployment_id, status}
deployment_current_executions{deployment_id}
deployment_pending_executions{deployment_id}
deployment_health{deployment_id, health_status}

// Execution metrics
execution_duration_seconds{deployment_id, status}
execution_total{deployment_id, trigger_type, status}
execution_tokens{deployment_id, token_type}

// Queue metrics
queue_depth{task_queue}
queue_latency_seconds{task_queue}
worker_active_activities{task_queue, worker_id}

// Quota metrics
quota_usage{tenant_id, tenant_type, resource_type}
quota_limit{tenant_id, tenant_type, resource_type}
```

### Alerting Rules

```yaml
# Alert when deployment unhealthy for > 5 minutes
- alert: DeploymentUnhealthy
  expr: deployment_health{health_status="unhealthy"} > 0
  for: 5m
  labels:
    severity: warning

# Alert when queue depth > 500
- alert: QueueBacklog
  expr: queue_depth > 500
  for: 2m
  labels:
    severity: warning

# Alert when execution failure rate > 10%
- alert: HighFailureRate
  expr: rate(execution_total{status="failed"}[5m]) / rate(execution_total[5m]) > 0.1
  for: 5m
  labels:
    severity: critical
```

---

## Summary

This architecture provides:

1. **Multi-Tenancy**: Full support for personal and organizational accounts with proper isolation
2. **High Concurrency**: Scales to 2000+ concurrent executions with horizontal scaling
3. **Durability**: Temporal-based execution with automatic recovery and continue-as-new
4. **Extensibility**: Easy to add new trigger types, queue strategies, and agent capabilities
5. **Fair Scheduling**: Queue sharding prevents head-of-line blocking between tenants
6. **Resource Control**: Quotas and rate limits per user/organization

The implementation follows existing patterns in the codebase (multi-tenancy, Temporal workflows) while adding the missing deployment abstraction layer.

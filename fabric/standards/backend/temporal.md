# Temporal Workflows

## Overview

This document defines standards for building durable workflows with Temporal. Temporal provides reliable workflow orchestration with automatic retries, state persistence, and long-running operation support.

## When to Apply

- Long-running operations (document processing, AI generation)
- Multi-step processes that need reliability
- Operations requiring human-in-the-loop approval
- Background jobs with retry requirements
- Scheduled or recurring tasks

## Core Principles

1. **Durability** - Workflows survive process restarts
2. **Determinism** - Workflows must be deterministic for replay
3. **Separation** - Activities handle side effects, workflows orchestrate
4. **Observability** - Complete execution history for debugging

## ✅ DO

### Workflow Structure

**✅ DO**: Follow the standard workflow pattern

```typescript
// packages/temporal/src/workflows/document-processing.ts
import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { DocumentProcessingInput, DocumentProcessingOutput } from "../types";

// Configure activities with appropriate timeouts and retries
const { updateDocumentStatus } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: {
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

const { processAndStoreChunks } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10m", // Long timeout for heavy operations
  retry: {
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

/**
 * Document Processing Workflow
 * 
 * Processes an uploaded document through the RAG pipeline:
 * 1. Update status to PROCESSING
 * 2. Download, extract, chunk, embed, store
 * 3. Update status to READY or FAILED
 */
export async function documentProcessingWorkflow(
  input: DocumentProcessingInput,
): Promise<DocumentProcessingOutput> {
  const { documentId, chatId, userId, organizationId } = input;

  log.info("Starting document processing workflow", { documentId });

  try {
    // Step 1: Update status
    await updateDocumentStatus(documentId, "PROCESSING", "RUNNING");

    // Step 2: Process document (all heavy work in single activity)
    const result = await processAndStoreChunks(
      documentId,
      chatId,
      userId,
      organizationId,
    );

    // Step 3: Mark complete
    await updateDocumentStatus(documentId, "READY", "COMPLETED");

    log.info("Document processing completed", { documentId });

    return {
      success: true,
      documentId,
      chunkCount: result.chunkCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log.error("Document processing failed", { documentId, error: errorMessage });

    // Best-effort status update
    try {
      await updateDocumentStatus(documentId, "FAILED", "FAILED", undefined, errorMessage);
    } catch {
      // Ignore
    }

    return {
      success: false,
      documentId,
      error: errorMessage,
    };
  }
}
```

### Activity Design

**✅ DO**: Keep activities focused and idempotent

```typescript
// packages/temporal/src/activities/document-activities.ts
import { db } from "@repo/database";
import { downloadFromS3, extractText, chunkText, generateEmbeddings, storeInQdrant } from "../lib";

/**
 * Update document status in database.
 * This is idempotent - safe to retry.
 */
export async function updateDocumentStatus(
  documentId: string,
  status: "PROCESSING" | "READY" | "FAILED",
  workflowStatus: "RUNNING" | "COMPLETED" | "FAILED",
  metadata?: { extractorUsed?: string },
  error?: string,
): Promise<void> {
  await db.chatDocument.update({
    where: { id: documentId },
    data: {
      status,
      workflowStatus,
      extractorUsed: metadata?.extractorUsed,
      errorMessage: error,
    },
  });
}

/**
 * Process document end-to-end.
 * Combined into single activity to avoid passing large buffers through Temporal.
 */
export async function processAndStoreChunks(
  documentId: string,
  chatId: string,
  userId: string,
  organizationId?: string,
): Promise<{ chunkCount: number; extractorUsed: string }> {
  // 1. Get document metadata
  const doc = await db.chatDocument.findUniqueOrThrow({
    where: { id: documentId },
  });

  // 2. Download from S3
  const buffer = await downloadFromS3(doc.s3Path);

  // 3. Extract text
  const { text, extractor } = await extractText(buffer, doc.mimeType);

  // 4. Chunk text
  const chunks = chunkText(text);

  // 5. Generate embeddings
  const embeddings = await generateEmbeddings(chunks);

  // 6. Store in database and vector store
  await Promise.all([
    storeChunksInDatabase(documentId, chatId, userId, organizationId, chunks),
    storeInQdrant(documentId, chunks, embeddings),
  ]);

  return {
    chunkCount: chunks.length,
    extractorUsed: extractor,
  };
}
```

### Timeout Configuration

**✅ DO**: Set appropriate timeouts for each activity type

```typescript
// Quick operations (status updates, notifications)
const quickActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: {
    maximumAttempts: 5,
  },
});

// Medium operations (API calls, database queries)
const mediumActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "2m",
  retry: {
    initialInterval: "5s",
    maximumAttempts: 3,
  },
});

// Heavy operations (AI generation, file processing)
const heavyActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "10m",
  heartbeatTimeout: "30s", // For long-running with progress
  retry: {
    initialInterval: "10s",
    maximumInterval: "2m",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});
```

### Starting Workflows

**✅ DO**: Start workflows from API procedures

```typescript
// packages/api/modules/ai/procedures/process-document.ts
import { getTemporalClient } from "@repo/temporal";
import { protectedProcedure } from "../../../orpc/procedures";

export const processDocumentProcedure = protectedProcedure
  .input(z.object({ documentId: z.string() }))
  .handler(async ({ input, context }) => {
    const client = await getTemporalClient();

    const handle = await client.workflow.start(documentProcessingWorkflow, {
      taskQueue: "document-processing",
      workflowId: `doc-${input.documentId}`,
      args: [{
        documentId: input.documentId,
        userId: context.user.id,
        organizationId: context.session.activeOrganizationId,
      }],
    });

    // Update document with workflow reference
    await db.chatDocument.update({
      where: { id: input.documentId },
      data: {
        workflowId: handle.workflowId,
        workflowRunId: handle.firstExecutionRunId,
        workflowStatus: "RUNNING",
      },
    });

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  });
```

### Workflow Signals and Queries

**✅ DO**: Use signals for external input and queries for state

```typescript
// packages/temporal/src/workflows/approval-workflow.ts
import { defineSignal, defineQuery, setHandler, condition } from "@temporalio/workflow";

// Define signals and queries
export const approveSignal = defineSignal<[{ approved: boolean; feedback?: string }]>("approve");
export const statusQuery = defineQuery<{ status: string; waitingFor: string[] }>("status");

export async function approvalWorkflow(input: ApprovalInput): Promise<ApprovalOutput> {
  let approval: { approved: boolean; feedback?: string } | undefined;
  let status = "pending";

  // Set up signal handler
  setHandler(approveSignal, (data) => {
    approval = data;
    status = data.approved ? "approved" : "rejected";
  });

  // Set up query handler
  setHandler(statusQuery, () => ({
    status,
    waitingFor: approval ? [] : [input.approverEmail],
  }));

  // Send notification
  await sendApprovalRequest(input.approverEmail, input.itemId);

  // Wait for approval (with timeout)
  const approved = await condition(() => approval !== undefined, "7d");

  if (!approved) {
    return { success: false, reason: "Approval timed out" };
  }

  return {
    success: approval!.approved,
    feedback: approval!.feedback,
  };
}
```

## ❌ DON'T

### Non-Deterministic Code in Workflows

**❌ DON'T**: Use non-deterministic operations in workflows

```typescript
// Bad: Non-deterministic operations
export async function badWorkflow() {
  // ❌ Random values change on replay
  const id = Math.random().toString();

  // ❌ Current time changes on replay
  const now = new Date();

  // ❌ Direct I/O in workflow
  const data = await fetch("https://api.example.com/data");

  // ❌ File system access
  const file = fs.readFileSync("config.json");
}
```
**Why**: Workflows must be deterministic for replay. Different values on replay cause non-determinism errors.

**✅ Better**:

```typescript
// Good: Use Temporal APIs and activities
import { uuid4 } from "@temporalio/workflow";

export async function goodWorkflow() {
  // ✅ Deterministic UUID from Temporal
  const id = uuid4();

  // ✅ Get time from activity
  const { now } = await getServerTime();

  // ✅ External calls in activities
  const data = await fetchExternalData("https://api.example.com/data");

  // ✅ File reading in activities
  const config = await readConfigFile();
}
```

### Large Data in Workflow Parameters

**❌ DON'T**: Pass large data through workflow parameters

```typescript
// Bad: Passing file buffer through Temporal (4MB limit)
export async function badWorkflow(input: {
  fileBuffer: Buffer;  // ❌ Could be many MB
  metadata: any;
}) {
  await processFile(input.fileBuffer);
}
```
**Why**: Temporal has a 4MB payload limit. Large data bloats history.

**✅ Better**:

```typescript
// Good: Pass references, fetch data in activities
export async function goodWorkflow(input: {
  s3Path: string;      // ✅ Just a reference
  documentId: string;
}) {
  // Activity downloads from S3
  await processDocumentFromS3(input.s3Path, input.documentId);
}
```

### Missing Error Handling

**❌ DON'T**: Let workflows fail without cleanup

```typescript
// Bad: No error handling or cleanup
export async function badWorkflow(input: Input) {
  await updateStatus("PROCESSING");
  await processData(input);  // If this fails, status stays PROCESSING
  await updateStatus("COMPLETED");
}
```

**✅ Better**:

```typescript
// Good: Proper error handling with cleanup
export async function goodWorkflow(input: Input) {
  try {
    await updateStatus("PROCESSING");
    await processData(input);
    await updateStatus("COMPLETED");
    return { success: true };
  } catch (error) {
    // Cleanup on failure
    try {
      await updateStatus("FAILED", error.message);
    } catch {
      // Best effort
    }
    return { success: false, error: error.message };
  }
}
```

## Patterns & Examples

### Pattern 1: Saga Pattern with Compensation

**Use Case**: Multi-step operations with rollback

```typescript
export async function orderWorkflow(order: Order): Promise<OrderResult> {
  const compensations: Array<() => Promise<void>> = [];

  try {
    // Step 1: Reserve inventory
    await reserveInventory(order.items);
    compensations.push(() => releaseInventory(order.items));

    // Step 2: Charge payment
    const paymentId = await chargePayment(order.payment);
    compensations.push(() => refundPayment(paymentId));

    // Step 3: Create shipment
    const shipmentId = await createShipment(order);
    compensations.push(() => cancelShipment(shipmentId));

    // Step 4: Send confirmation
    await sendConfirmation(order.email, shipmentId);

    return { success: true, shipmentId };
  } catch (error) {
    // Execute compensations in reverse order
    for (const compensate of compensations.reverse()) {
      try {
        await compensate();
      } catch (compError) {
        log.error("Compensation failed", { error: compError });
      }
    }
    return { success: false, error: error.message };
  }
}
```

### Pattern 2: Child Workflows for Parallelism

**Use Case**: Processing multiple items in parallel

```typescript
import { executeChild } from "@temporalio/workflow";

export async function batchProcessingWorkflow(
  input: { documentIds: string[] },
): Promise<BatchResult> {
  // Start all child workflows in parallel
  const handles = input.documentIds.map((documentId) =>
    executeChild(documentProcessingWorkflow, {
      workflowId: `doc-${documentId}`,
      args: [{ documentId }],
    }),
  );

  // Wait for all to complete
  const results = await Promise.allSettled(handles);

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  return {
    total: input.documentIds.length,
    succeeded,
    failed,
  };
}
```

### Pattern 3: Scheduled Workflows

**Use Case**: Recurring tasks

```typescript
import { continueAsNew, sleep } from "@temporalio/workflow";

export async function dailyReportWorkflow(input: { lastRunAt?: Date }): Promise<void> {
  // Generate report
  await generateDailyReport();

  // Wait until tomorrow (using Temporal's durable timer)
  await sleep("24h");

  // Continue as new to avoid unbounded history
  await continueAsNew<typeof dailyReportWorkflow>({
    lastRunAt: new Date(),
  });
}
```

### Pattern 4: Human-in-the-Loop

**Use Case**: Workflows requiring human approval

```typescript
import { condition, defineSignal, setHandler } from "@temporalio/workflow";

export const reviewSignal = defineSignal<[ReviewDecision]>("review");

export async function contentReviewWorkflow(
  content: Content,
): Promise<ReviewResult> {
  let decision: ReviewDecision | undefined;

  setHandler(reviewSignal, (d) => {
    decision = d;
  });

  // Notify reviewer
  await notifyReviewer(content);

  // Wait for review (7 day timeout)
  const received = await condition(() => decision !== undefined, "7d");

  if (!received) {
    await notifyTimeout(content.authorEmail);
    return { status: "timeout" };
  }

  if (decision!.approved) {
    await publishContent(content);
    return { status: "published" };
  }

  await notifyRejection(content.authorEmail, decision!.feedback);
  return { status: "rejected", feedback: decision!.feedback };
}

// API to send signal
export const reviewContentProcedure = protectedProcedure
  .input(z.object({
    workflowId: z.string(),
    approved: z.boolean(),
    feedback: z.string().optional(),
  }))
  .handler(async ({ input }) => {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(input.workflowId);
    
    await handle.signal(reviewSignal, {
      approved: input.approved,
      feedback: input.feedback,
    });

    return { success: true };
  });
```

## Worker Configuration

```typescript
// packages/temporal/src/worker.ts
import { Worker } from "@temporalio/worker";
import * as activities from "./activities";

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: "document-processing",
    // Concurrency settings
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 20,
    // Sticky queue for workflow task caching
    stickyQueueScheduleToStartTimeout: "10s",
  });

  await worker.run();
}

run().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
```

## Common Mistakes

1. **Using `Date.now()` in workflows**
   - Problem: Non-deterministic on replay
   - Solution: Use `Temporal.now()` or get time from activity

2. **Passing large payloads**
   - Problem: Exceeds 4MB limit, slow replays
   - Solution: Store data externally, pass references

3. **Infinite loops without `continueAsNew`**
   - Problem: Unbounded event history
   - Solution: Use `continueAsNew` for long-running workflows

4. **Not handling activity failures**
   - Problem: Workflow hangs or fails unexpectedly
   - Solution: Wrap activities in try-catch, implement compensation

## Resources

- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript)
- [Workflow Determinism](https://docs.temporal.io/workflows#deterministic-constraints)
- [Temporal Best Practices](https://docs.temporal.io/develop/typescript/core-application)


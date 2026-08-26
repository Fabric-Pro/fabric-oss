# Error Handling

## Overview

This document defines error handling patterns for the Fabric Portal codebase. Proper error handling ensures reliability, debuggability, and good user experience.

## When to Apply

- Writing API procedures
- Creating React components
- Implementing async operations
- Building Temporal workflows
- Handling form submissions

## Core Principles

1. **Fail Fast** - Detect errors early, before they propagate
2. **Be Specific** - Use typed errors with clear messages
3. **Graceful Degradation** - Handle errors without crashing
4. **Observability** - Log errors with context for debugging

## ✅ DO

### API Error Handling (oRPC)

**✅ DO**: Use ORPCError with appropriate codes

```typescript
import { ORPCError } from "@orpc/server";

export const getWorkflowProcedure = protectedProcedure
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, context }) => {
    const workflow = await getWorkflowById(input.id);
    
    // Not found
    if (!workflow) {
      throw new ORPCError("NOT_FOUND", {
        message: "Workflow not found",
      });
    }
    
    // Authorization check
    if (workflow.userId !== context.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You do not have access to this workflow",
      });
    }
    
    return { workflow };
  });
```

**✅ DO**: Use standard error codes consistently

```typescript
// Authentication errors
throw new ORPCError("UNAUTHORIZED");  // Not logged in

// Authorization errors
throw new ORPCError("FORBIDDEN", {
  message: "You are not a member of this organization",
});

// Validation errors (handled automatically by Zod)
// oRPC returns BAD_REQUEST with validation details

// Not found errors
throw new ORPCError("NOT_FOUND", {
  message: "Resource not found",
});

// Conflict errors
throw new ORPCError("CONFLICT", {
  message: "Workflow with this name already exists",
});

// Server errors
throw new ORPCError("INTERNAL_SERVER_ERROR", {
  message: "Failed to process request",
});
```

### React Error Handling

**✅ DO**: Use Error Boundaries for component errors

```tsx
// modules/saas/agents/components/AgentErrorBoundary.tsx
"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@ui/components/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class AgentErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Agent error:", error, errorInfo);
    // Send to error tracking service
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="p-4 border border-destructive rounded-lg">
          <h3 className="font-semibold text-destructive">Something went wrong</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {this.state.error?.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

**✅ DO**: Handle async errors in hooks

```tsx
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

export function useWorkflowActions() {
  const createMutation = useMutation({
    mutationFn: async (data: CreateWorkflowInput) => {
      return await api.workflows.create(data);
    },
    onSuccess: (result) => {
      toast.success("Workflow created successfully");
      router.push(`/app/workflows/${result.workflow.id}`);
    },
    onError: (error) => {
      // Handle specific error types
      if (error instanceof ORPCError) {
        switch (error.code) {
          case "FORBIDDEN":
            toast.error("You don't have permission to create workflows");
            break;
          case "CONFLICT":
            toast.error("A workflow with this name already exists");
            break;
          default:
            toast.error(error.message || "Failed to create workflow");
        }
      } else {
        toast.error("An unexpected error occurred");
        console.error("Create workflow error:", error);
      }
    },
  });

  return { createWorkflow: createMutation };
}
```

### Temporal Workflow Error Handling

**✅ DO**: Handle workflow failures with proper status updates

```typescript
// packages/temporal/src/workflows/document-processing.ts
import { log, proxyActivities } from "@temporalio/workflow";

const { updateDocumentStatus, processAndStoreChunks } = proxyActivities({
  startToCloseTimeout: "10m",
  retry: {
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

export async function documentProcessingWorkflow(
  input: DocumentProcessingInput,
): Promise<DocumentProcessingOutput> {
  const { documentId } = input;

  log.info("Starting document processing", { documentId });

  try {
    await updateDocumentStatus(documentId, "PROCESSING", "RUNNING");
    
    const result = await processAndStoreChunks(documentId);
    
    await updateDocumentStatus(documentId, "READY", "COMPLETED");
    
    return { success: true, documentId, ...result };
  } catch (error) {
    const errorMessage = error instanceof Error 
      ? error.message 
      : "Unknown error";

    log.error("Document processing failed", { documentId, error: errorMessage });

    // Best-effort status update
    try {
      await updateDocumentStatus(
        documentId,
        "FAILED",
        "FAILED",
        undefined,
        errorMessage,
      );
    } catch {
      // Ignore status update failures
    }

    return { success: false, documentId, error: errorMessage };
  }
}
```

### Form Validation Errors

**✅ DO**: Display validation errors clearly

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

const createWorkflowSchema = z.object({
  name: z.string().min(1, "Name is required").max(255, "Name is too long"),
  description: z.string().optional(),
});

export function CreateWorkflowForm() {
  const form = useForm({
    resolver: zodResolver(createWorkflowSchema),
    defaultValues: { name: "", description: "" },
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <div>
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          {...form.register("name")}
          aria-invalid={!!form.formState.errors.name}
        />
        {form.formState.errors.name && (
          <p className="text-sm text-destructive mt-1">
            {form.formState.errors.name.message}
          </p>
        )}
      </div>
      
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Creating..." : "Create"}
      </Button>
    </form>
  );
}
```

## ❌ DON'T

### Silent Failures

**❌ DON'T**: Swallow errors without handling

```typescript
// Bad: Error is silently ignored
try {
  await saveWorkflow(data);
} catch {
  // Nothing happens
}

// Good: Handle or rethrow
try {
  await saveWorkflow(data);
} catch (error) {
  console.error("Failed to save workflow:", error);
  toast.error("Failed to save workflow. Please try again.");
}
```
**Why**: Silent failures are impossible to debug and confuse users.

### Generic Error Messages

**❌ DON'T**: Show generic error messages

```typescript
// Bad: Unhelpful message
catch (error) {
  toast.error("Error");
}

// Good: Specific, actionable message
catch (error) {
  if (error.code === "NETWORK_ERROR") {
    toast.error("Network error. Check your connection and try again.");
  } else if (error.code === "VALIDATION_ERROR") {
    toast.error("Please check your input and try again.");
  } else {
    toast.error("Something went wrong. Please try again later.");
  }
}
```
**Why**: Users need to know what happened and what to do.

### Exposing Internal Errors

**❌ DON'T**: Expose stack traces or internal details to users

```typescript
// Bad: Leaks internal details
throw new ORPCError("INTERNAL_SERVER_ERROR", {
  message: error.stack,  // Exposes file paths and code
});

// Good: Generic message for users, detailed logs for developers
console.error("Database error:", error);
throw new ORPCError("INTERNAL_SERVER_ERROR", {
  message: "An internal error occurred. Please try again.",
});
```
**Why**: Stack traces can expose security vulnerabilities.

### Catching Too Broadly

**❌ DON'T**: Catch all errors without discrimination

```typescript
// Bad: Catches everything, including programming errors
try {
  const result = someFunction();
  await saveResult(result);
} catch {
  return { error: "Failed" };  // Hides actual bugs
}

// Good: Catch specific errors
try {
  await saveToDatabase(data);
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ORPCError("CONFLICT", { message: "Duplicate entry" });
    }
  }
  throw error;  // Rethrow unexpected errors
}
```
**Why**: Broad catches hide bugs and make debugging harder.

## Patterns & Examples

### Pattern 1: Typed API Errors

**Use Case**: Consistent error handling across the API

```typescript
// packages/api/lib/errors.ts
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(
      `${resource} with id '${id}' not found`,
      "NOT_FOUND",
      404,
    );
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(message, "FORBIDDEN", 403);
  }
}

// Usage in procedures
if (!workflow) {
  throw new NotFoundError("Workflow", input.id);
}
```

### Pattern 2: React Query Error States

**Use Case**: Handling loading and error states in UI

```tsx
export function WorkflowList() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows.list(),
  });

  if (isLoading) {
    return <WorkflowListSkeleton />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
        <h3 className="font-semibold">Failed to load workflows</h3>
        <p className="text-muted-foreground mt-1">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button variant="outline" className="mt-4" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return <WorkflowGrid workflows={data.workflows} />;
}
```

### Pattern 3: Async Action with Loading State

**Use Case**: Button that triggers async action

```tsx
export function DeleteWorkflowButton({ workflowId }: { workflowId: string }) {
  const [isPending, startTransition] = useTransition();
  
  const handleDelete = () => {
    startTransition(async () => {
      try {
        await api.workflows.delete({ id: workflowId });
        toast.success("Workflow deleted");
        router.push("/app/workflows");
      } catch (error) {
        toast.error(
          error instanceof Error 
            ? error.message 
            : "Failed to delete workflow"
        );
      }
    });
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" disabled={isPending}>
          {isPending ? "Deleting..." : "Delete"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

## Common Mistakes

1. **Not handling network errors**
   - Problem: Component crashes when offline
   - Solution: Add error boundaries and retry logic

2. **Forgetting to reset error state**
   - Problem: Error message persists after successful retry
   - Solution: Clear error state on retry or success

3. **Logging sensitive data**
   - Problem: Passwords/tokens in error logs
   - Solution: Sanitize errors before logging

4. **Missing error types in TypeScript**
   - Problem: `catch (error)` has `unknown` type
   - Solution: Use type guards or `instanceof` checks

## Error Logging

```typescript
// packages/logs/lib/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Usage
logger.error({
  err: error,
  userId: context.user.id,
  workflowId: input.id,
  action: "delete_workflow",
}, "Failed to delete workflow");
```

## Resources

- [oRPC Error Handling](https://orpc.dev/docs/error-handling)
- [React Error Boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary)
- [TanStack Query Error Handling](https://tanstack.com/query/latest/docs/framework/react/guides/query-functions#handling-errors)
- [Temporal Error Handling](https://docs.temporal.io/develop/typescript/failure-detection)

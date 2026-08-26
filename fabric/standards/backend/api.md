# API Design with oRPC

## Overview

This document defines API design standards for the Fabric Portal using oRPC, a type-safe RPC framework that provides end-to-end type safety between client and server.

## When to Apply

- Creating new API endpoints
- Refactoring existing API routes
- Adding authentication/authorization
- Designing API responses
- Building integrations

## Core Principles

1. **Type Safety** - End-to-end type inference from server to client
2. **Procedure-Based** - Operations are procedures, not REST resources
3. **Middleware Composition** - Authentication and authorization via middleware
4. **Schema Validation** - Zod schemas for input/output validation

## ✅ DO

### Procedure Structure

**✅ DO**: Follow the standard procedure structure

```typescript
// packages/api/modules/workflows/procedures/create-workflow.ts
import { ORPCError } from "@orpc/server";
import { createWorkflow, type Prisma } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const createWorkflowProcedure = protectedProcedure
  // 1. Route metadata for OpenAPI
  .route({
    method: "POST",
    path: "/workflows",
    tags: ["Workflows"],
    summary: "Create workflow",
    description: "Create a new workflow",
  })
  // 2. Input validation with Zod
  .input(
    z.object({
      name: z.string().min(1).max(255),
      description: z.string().optional(),
      triggerType: z.enum(["MANUAL", "WEBHOOK", "SCHEDULE"]).default("MANUAL"),
      organizationId: z.string().optional(),
    }),
  )
  // 3. Handler with typed context and input
  .handler(async ({ input, context }) => {
    const user = context.user;

    // 4. Authorization check
    if (input.organizationId) {
      const membership = await verifyOrganizationMembership(
        input.organizationId,
        user.id,
      );
      if (!membership) {
        throw new ORPCError("FORBIDDEN", {
          message: "You are not a member of this organization",
        });
      }
    }

    // 5. Business logic
    const workflow = await createWorkflow({
      name: input.name,
      description: input.description,
      triggerType: input.triggerType,
      userId: user.id,
      organizationId: input.organizationId,
    });

    // 6. Return typed response
    return { workflow };
  });
```

### Base Procedures

**✅ DO**: Use the appropriate base procedure

```typescript
// packages/api/orpc/procedures.ts
import { ORPCError, os } from "@orpc/server";
import { auth } from "@repo/auth";

// Public procedure - no auth required
export const publicProcedure = os.$context<{
  headers: Headers;
}>();

// Protected procedure - requires authentication
export const protectedProcedure = publicProcedure.use(
  async ({ context, next }) => {
    const session = await auth.api.getSession({
      headers: context.headers,
    });

    if (!session) {
      throw new ORPCError("UNAUTHORIZED");
    }

    return await next({
      context: {
        session: session.session,
        user: session.user,
      },
    });
  },
);

// Admin procedure - requires admin role
export const adminProcedure = protectedProcedure.use(
  async ({ context, next }) => {
    if (context.user.role !== "admin") {
      throw new ORPCError("FORBIDDEN");
    }
    return await next();
  },
);
```

**✅ DO**: Choose the right procedure for each endpoint

```typescript
// Public endpoints (no auth)
export const healthCheckProcedure = publicProcedure
  .handler(() => ({ status: "ok" }));

// User endpoints (requires login)
export const getWorkflowProcedure = protectedProcedure
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, context }) => { /* ... */ });

// Admin endpoints (requires admin role)
export const listAllUsersProcedure = adminProcedure
  .handler(async () => { /* ... */ });
```

### Router Organization

**✅ DO**: Organize routers by domain with nested structure

```typescript
// packages/api/modules/workflows/router.ts
export const workflowsRouter = {
  // CRUD at root level
  list: listWorkflowsProcedure,
  get: getWorkflowProcedure,
  create: createWorkflowProcedure,
  update: updateWorkflowProcedure,
  delete: deleteWorkflowProcedure,

  // Related operations nested
  publish: {
    publish: publishWorkflowProcedure,
    unpublish: unpublishWorkflowProcedure,
    rollback: rollbackWorkflowProcedure,
  },

  versions: {
    list: listVersionsProcedure,
    create: createVersionProcedure,
  },

  executions: {
    list: listExecutionsProcedure,
    get: getExecutionProcedure,
    start: startExecutionProcedure,
  },

  integrations: {
    list: listIntegrationsProcedure,
    save: saveIntegrationProcedure,
    delete: deleteIntegrationProcedure,
    testConnection: testConnectionProcedure,
  },
};
```

**✅ DO**: Combine all routers in the main router

```typescript
// packages/api/orpc/router.ts
import { publicProcedure } from "./procedures";
import { workflowsRouter } from "../modules/workflows/router";
import { usersRouter } from "../modules/users/router";
import { organizationsRouter } from "../modules/organizations/router";

export const router = publicProcedure
  .prefix("/api")
  .router({
    workflows: workflowsRouter,
    users: usersRouter,
    organizations: organizationsRouter,
    agents: agentsRouter,
    prompts: promptsRouter,
    projects: projectsRouter,
  });

export type Router = typeof router;
```

### Input Validation

**✅ DO**: Use Zod schemas for comprehensive validation

```typescript
// Define reusable schemas
const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

const workflowFilterSchema = z.object({
  status: z.enum(["DRAFT", "PUBLISHED", "ACTIVE", "ARCHIVED"]).optional(),
  triggerType: z.enum(["MANUAL", "WEBHOOK", "SCHEDULE"]).optional(),
  search: z.string().optional(),
});

// Use in procedure
export const listWorkflowsProcedure = protectedProcedure
  .input(
    z.object({
      organizationId: z.string().optional(),
      ...paginationSchema.shape,
      ...workflowFilterSchema.shape,
    }),
  )
  .handler(async ({ input, context }) => {
    const workflows = await listWorkflows({
      userId: context.user.id,
      organizationId: input.organizationId,
      status: input.status,
      triggerType: input.triggerType,
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    });

    return { workflows };
  });
```

### Output Types

**✅ DO**: Define explicit output schemas for documentation

```typescript
export const getWorkflowProcedure = protectedProcedure
  .route({
    method: "GET",
    path: "/workflows/{id}",
    tags: ["Workflows"],
  })
  .input(z.object({ id: z.string() }))
  .output(
    z.object({
      workflow: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        status: z.enum(["DRAFT", "PUBLISHED", "ACTIVE", "ARCHIVED"]),
        triggerType: z.enum(["MANUAL", "WEBHOOK", "SCHEDULE"]),
        version: z.number(),
        createdAt: z.date(),
        updatedAt: z.date(),
      }),
    }),
  )
  .handler(async ({ input, context }) => {
    const workflow = await getWorkflowById(input.id);
    
    if (!workflow) {
      throw new ORPCError("NOT_FOUND", {
        message: "Workflow not found",
      });
    }

    // Verify access
    if (workflow.userId !== context.user.id) {
      throw new ORPCError("FORBIDDEN");
    }

    return { workflow };
  });
```

## ❌ DON'T

### Mixing Concerns

**❌ DON'T**: Put business logic directly in procedures

```typescript
// Bad: Business logic mixed with procedure
export const createWorkflowProcedure = protectedProcedure
  .input(createWorkflowSchema)
  .handler(async ({ input, context }) => {
    // ❌ Database logic directly here
    const workflow = await db.workflow.create({
      data: {
        name: input.name,
        userId: context.user.id,
        // ... lots of fields
      },
    });

    // ❌ Notification logic
    await sendEmail(context.user.email, "Workflow created", ...);

    // ❌ Analytics
    await trackEvent("workflow_created", { id: workflow.id });

    return { workflow };
  });
```
**Why**: Hard to test, violates single responsibility.

**✅ Better**:

```typescript
// Good: Delegate to database queries and services
export const createWorkflowProcedure = protectedProcedure
  .input(createWorkflowSchema)
  .handler(async ({ input, context }) => {
    // Business logic in database/service layer
    const workflow = await createWorkflow({
      ...input,
      userId: context.user.id,
    });

    return { workflow };
  });
```

### Skipping Authorization

**❌ DON'T**: Forget to check resource ownership

```typescript
// Bad: No ownership check
export const deleteWorkflowProcedure = protectedProcedure
  .input(z.object({ id: z.string() }))
  .handler(async ({ input }) => {
    // ❌ Anyone can delete any workflow!
    await deleteWorkflow(input.id);
    return { success: true };
  });
```

**✅ Better**:

```typescript
// Good: Check ownership and organization membership
export const deleteWorkflowProcedure = protectedProcedure
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, context }) => {
    const workflow = await getWorkflowById(input.id);

    if (!workflow) {
      throw new ORPCError("NOT_FOUND");
    }

    // Check ownership or organization membership
    const hasAccess = await hasWorkflowAccess(workflow, context.user.id);
    if (!hasAccess) {
      throw new ORPCError("FORBIDDEN");
    }

    await deleteWorkflow(input.id);
    return { success: true };
  });
```

### Inconsistent Error Codes

**❌ DON'T**: Use arbitrary error codes

```typescript
// Bad: Inconsistent error handling
if (!user) {
  throw new Error("Not found");
}

if (!hasPermission) {
  throw new ORPCError("ERROR", { message: "No access" });
}
```

**✅ Better**:

```typescript
// Good: Consistent error codes
if (!user) {
  throw new ORPCError("NOT_FOUND", { message: "User not found" });
}

if (!hasPermission) {
  throw new ORPCError("FORBIDDEN", { message: "Access denied" });
}
```

### Returning Database Models Directly

**❌ DON'T**: Expose internal database structure

```typescript
// Bad: Exposes all fields including sensitive ones
export const getUserProcedure = protectedProcedure
  .handler(async ({ context }) => {
    const user = await db.user.findUnique({
      where: { id: context.user.id },
    });
    return { user }; // ❌ Includes password hash, internal IDs, etc.
  });
```

**✅ Better**:

```typescript
// Good: Select only needed fields
export const getUserProcedure = protectedProcedure
  .handler(async ({ context }) => {
    const user = await db.user.findUnique({
      where: { id: context.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        createdAt: true,
      },
    });
    return { user };
  });
```

## Patterns & Examples

### Pattern 1: Organization-Aware Procedures

**Use Case**: Endpoints that support both user and organization scope

```typescript
export const listWorkflowsProcedure = protectedProcedure
  .input(
    z.object({
      organizationId: z.string().optional(),
      limit: z.number().default(20),
      offset: z.number().default(0),
    }),
  )
  .handler(async ({ input, context }) => {
    // If organization specified, verify membership
    if (input.organizationId) {
      const isMember = await verifyOrganizationMembership(
        input.organizationId,
        context.user.id,
      );
      if (!isMember) {
        throw new ORPCError("FORBIDDEN", {
          message: "You are not a member of this organization",
        });
      }
    }

    // Query based on scope
    const workflows = await listWorkflows({
      userId: input.organizationId ? undefined : context.user.id,
      organizationId: input.organizationId,
      limit: input.limit,
      offset: input.offset,
    });

    return { workflows };
  });
```

### Pattern 2: Bulk Operations

**Use Case**: Operations on multiple resources

```typescript
export const bulkDeleteWorkflowsProcedure = protectedProcedure
  .input(
    z.object({
      ids: z.array(z.string()).min(1).max(50),
    }),
  )
  .handler(async ({ input, context }) => {
    // Verify access to all workflows
    const workflows = await db.workflow.findMany({
      where: { id: { in: input.ids } },
      select: { id: true, userId: true, organizationId: true },
    });

    // Check each workflow
    const unauthorized = workflows.filter(
      (w) => w.userId !== context.user.id,
    );
    if (unauthorized.length > 0) {
      throw new ORPCError("FORBIDDEN", {
        message: `Cannot delete workflows: ${unauthorized.map(w => w.id).join(", ")}`,
      });
    }

    // Perform bulk delete
    const result = await db.workflow.deleteMany({
      where: { id: { in: input.ids } },
    });

    return { deleted: result.count };
  });
```

### Pattern 3: File Upload URL Generation

**Use Case**: Pre-signed URLs for direct S3 upload

```typescript
export const createUploadUrlProcedure = protectedProcedure
  .input(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      size: z.number().max(10 * 1024 * 1024), // 10MB max
    }),
  )
  .handler(async ({ input, context }) => {
    const key = `uploads/${context.user.id}/${crypto.randomUUID()}/${input.filename}`;

    const { url, fields } = await createPresignedPost({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Conditions: [
        ["content-length-range", 0, input.size],
        ["eq", "$Content-Type", input.contentType],
      ],
      Expires: 300, // 5 minutes
    });

    return { url, fields, key };
  });
```

### Pattern 4: Pagination with Cursors

**Use Case**: Efficient pagination for large datasets

```typescript
export const listExecutionsProcedure = protectedProcedure
  .input(
    z.object({
      workflowId: z.string(),
      cursor: z.string().optional(),
      limit: z.number().min(1).max(100).default(20),
    }),
  )
  .handler(async ({ input, context }) => {
    const executions = await db.workflowExecution.findMany({
      where: { workflowId: input.workflowId },
      take: input.limit + 1, // Fetch one extra to determine hasNext
      cursor: input.cursor ? { id: input.cursor } : undefined,
      orderBy: { startedAt: "desc" },
    });

    const hasNext = executions.length > input.limit;
    const items = hasNext ? executions.slice(0, -1) : executions;
    const nextCursor = hasNext ? items[items.length - 1].id : undefined;

    return {
      executions: items,
      pagination: {
        hasNext,
        nextCursor,
      },
    };
  });
```

## Client Usage

**✅ DO**: Use the typed client with TanStack Query

```typescript
// apps/web/modules/saas/workflows/hooks/useWorkflowActions.ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export function useWorkflows(organizationId?: string) {
  return useQuery({
    queryKey: ["workflows", { organizationId }],
    queryFn: () => api.workflows.list({ organizationId }),
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateWorkflowInput) => api.workflows.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
}
```

## Testing

```typescript
import { describe, expect, it } from "vitest";
import { createWorkflowProcedure } from "./create-workflow";

describe("createWorkflowProcedure", () => {
  it("creates a workflow for authenticated user", async () => {
    const result = await createWorkflowProcedure.handler({
      input: { name: "Test Workflow" },
      context: { user: mockUser, session: mockSession },
    });

    expect(result.workflow).toMatchObject({
      name: "Test Workflow",
      userId: mockUser.id,
    });
  });

  it("returns FORBIDDEN for non-member organization", async () => {
    await expect(
      createWorkflowProcedure.handler({
        input: { name: "Test", organizationId: "other-org" },
        context: { user: mockUser, session: mockSession },
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
});
```

## Resources

- [oRPC Documentation](https://orpc.dev)
- [Zod Documentation](https://zod.dev)
- [TanStack Query](https://tanstack.com/query)

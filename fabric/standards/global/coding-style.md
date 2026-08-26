# Coding Style

## Overview

This document defines coding style standards for the Fabric Portal codebase. These standards ensure consistency, readability, and maintainability across all TypeScript/React code.

## When to Apply

- Writing new code
- Refactoring existing code
- Code reviews
- Pair programming sessions

## Core Principles

1. **Type Safety First** - Leverage TypeScript's type system fully
2. **Explicit Over Implicit** - Clear intentions reduce bugs
3. **Consistency** - Follow established patterns
4. **Readability** - Code is read more than written

## ✅ DO

### Naming Conventions

**✅ DO**: Use consistent naming patterns across the codebase

```typescript
// Files and directories: kebab-case
// components/user-profile.tsx
// lib/api-client.ts
// hooks/use-session.ts

// React components: PascalCase
export function UserProfileCard({ user }: UserProfileCardProps) {}

// Functions and variables: camelCase
const userCount = await getUserCount();
function calculateTotalPrice(items: Item[]) {}

// Constants: SCREAMING_SNAKE_CASE
const MAX_RETRY_ATTEMPTS = 3;
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

// Types and interfaces: PascalCase
interface UserProfile {
  id: string;
  name: string;
}

type WorkflowStatus = "DRAFT" | "PUBLISHED" | "ACTIVE";

// Enums: PascalCase with SCREAMING_SNAKE_CASE values
enum AgentStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  DEPLOYING = "DEPLOYING",
}
```

### TypeScript Patterns

**✅ DO**: Use strict TypeScript with proper typing

```typescript
// Use interface for object shapes (preferred for extensibility)
interface WorkflowNodeData {
  label: string;
  config?: Record<string, unknown>;
  onDelete?: () => void;
}

// Use type for unions, intersections, and computed types
type WorkflowNodeType = "trigger" | "ai-generate-text" | "condition";

// Use Zod for runtime validation with type inference
const createWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  triggerType: WorkflowTriggerTypeSchema.optional().default("MANUAL"),
});

type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
```

**✅ DO**: Prefer explicit return types for public APIs

```typescript
// Good: Explicit return types for public functions
export async function getWorkflow(id: string): Promise<Workflow | null> {
  return await db.workflow.findUnique({ where: { id } });
}

// Good: Let TypeScript infer for internal/simple functions
const formatDate = (date: Date) => date.toISOString();
```

### Function Style

**✅ DO**: Keep functions small and focused

```typescript
// Good: Single responsibility
async function validateOrganizationMembership(
  organizationId: string,
  userId: string,
): Promise<Member | null> {
  return await db.member.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
  });
}

// Good: Extract complex logic into named functions
function calculateWorkflowStats(executions: WorkflowExecution[]): WorkflowStats {
  const completed = executions.filter(e => e.status === "COMPLETED");
  const failed = executions.filter(e => e.status === "FAILED");
  
  return {
    totalRuns: executions.length,
    successRate: completed.length / executions.length,
    averageDuration: calculateAverageDuration(completed),
  };
}
```

### Import Organization

**✅ DO**: Organize imports consistently

```typescript
// 1. Node.js built-ins
import path from "node:path";
import crypto from "node:crypto";

// 2. External packages
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";

// 3. Workspace packages (@repo/*)
import { db } from "@repo/database";
import { auth } from "@repo/auth";

// 4. Internal aliases (@ui, @saas, @shared)
import { Button } from "@ui/components/button";
import { useSession } from "@saas/auth/hooks/use-session";

// 5. Relative imports
import { formatDuration } from "../lib/format-duration";
import type { WorkflowNode } from "./types";
```

### Comments

**✅ DO**: Write meaningful comments that explain "why", not "what"

```typescript
// Good: Explains the reasoning
// We use a 300ms debounce to batch rapid node changes into single history entries
// This prevents the undo stack from filling with intermediate states
historyTimeoutRef.current = setTimeout(() => {
  commitToHistory(pendingStateRef.current);
}, 300);

// Good: JSDoc for public APIs
/**
 * Creates a new workflow with the specified configuration.
 * 
 * @param input - Workflow creation parameters
 * @returns The created workflow with generated ID
 * @throws {ORPCError} FORBIDDEN if user lacks organization membership
 */
export async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
  // ...
}
```

## ❌ DON'T

### Type Safety Violations

**❌ DON'T**: Use `any` without strong justification

```typescript
// Bad: any hides type errors
function processData(data: any) {
  return data.someProperty; // No type checking!
}
```
**Why**: Defeats TypeScript's purpose. Use `unknown` with type guards instead.

**❌ DON'T**: Use non-null assertions without checking

```typescript
// Bad: Crashes if user is null
const userName = user!.name;

// Good: Handle the null case
const userName = user?.name ?? "Unknown";
```
**Why**: Non-null assertions hide potential runtime errors.

### Naming Anti-Patterns

**❌ DON'T**: Use abbreviations or single-letter variables

```typescript
// Bad
const usr = await getUser(id);
const wf = workflows.find(w => w.id === wfId);
const cb = () => setOpen(false);

// Good
const user = await getUser(id);
const workflow = workflows.find(workflow => workflow.id === workflowId);
const handleClose = () => setOpen(false);
```
**Why**: Abbreviations reduce readability and searchability.

**❌ DON'T**: Use generic names

```typescript
// Bad
const data = await fetchData();
const result = processResult(data);
const items = getItems();

// Good
const workflows = await fetchWorkflows();
const validatedConfig = validateNodeConfig(rawConfig);
const activeMembers = getActiveOrganizationMembers();
```
**Why**: Generic names don't convey meaning.

### Function Anti-Patterns

**❌ DON'T**: Create deeply nested code

```typescript
// Bad: Arrow hell
if (user) {
  if (user.organization) {
    if (user.organization.members) {
      if (user.organization.members.length > 0) {
        // Finally do something
      }
    }
  }
}

// Good: Early returns
if (!user?.organization?.members?.length) {
  return null;
}
// Do something with valid data
```
**Why**: Deep nesting is hard to read and test.

**❌ DON'T**: Mix concerns in functions

```typescript
// Bad: Does too many things
async function saveWorkflowAndNotifyAndUpdateCache(workflow: Workflow) {
  await db.workflow.update({ where: { id: workflow.id }, data: workflow });
  await sendEmail(user.email, "Workflow Updated", ...);
  cache.invalidate(`workflow:${workflow.id}`);
  analytics.track("workflow_updated", { id: workflow.id });
}

// Good: Single responsibility
async function updateWorkflow(workflow: Workflow) {
  return await db.workflow.update({ where: { id: workflow.id }, data: workflow });
}
// Call notification/cache separately or use event-driven patterns
```
**Why**: Violates single responsibility principle.

## Patterns & Examples

### Pattern 1: Error Handling with Result Types

**Use Case**: Functions that can fail in expected ways

```typescript
type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

async function parseWorkflowConfig(
  raw: unknown,
): Result<WorkflowConfig, ValidationError> {
  const result = workflowConfigSchema.safeParse(raw);
  
  if (!result.success) {
    return {
      success: false,
      error: new ValidationError(result.error.message),
    };
  }
  
  return { success: true, data: result.data };
}
```

### Pattern 2: Builder Pattern for Complex Objects

**Use Case**: Creating objects with many optional parameters

```typescript
class WorkflowBuilder {
  private workflow: Partial<Workflow> = {};

  withName(name: string): this {
    this.workflow.name = name;
    return this;
  }

  withTrigger(type: TriggerType, config?: TriggerConfig): this {
    this.workflow.triggerType = type;
    this.workflow.triggerConfig = config;
    return this;
  }

  build(): Workflow {
    if (!this.workflow.name) {
      throw new Error("Workflow name is required");
    }
    return this.workflow as Workflow;
  }
}

// Usage
const workflow = new WorkflowBuilder()
  .withName("My Workflow")
  .withTrigger("WEBHOOK", { path: "/api/trigger" })
  .build();
```

### Pattern 3: Discriminated Unions for State

**Use Case**: Representing exclusive states

```typescript
type WorkflowExecutionState =
  | { status: "PENDING" }
  | { status: "RUNNING"; startedAt: Date; currentNode: string }
  | { status: "COMPLETED"; startedAt: Date; completedAt: Date; output: unknown }
  | { status: "FAILED"; startedAt: Date; failedAt: Date; error: string };

function renderExecutionStatus(state: WorkflowExecutionState) {
  switch (state.status) {
    case "PENDING":
      return <PendingBadge />;
    case "RUNNING":
      return <RunningBadge node={state.currentNode} />;
    case "COMPLETED":
      return <CompletedBadge duration={state.completedAt - state.startedAt} />;
    case "FAILED":
      return <FailedBadge error={state.error} />;
  }
}
```

## Common Mistakes

1. **Mixing async patterns**
   - Problem: Using `.then()` with `async/await` in same function
   - Solution: Pick one style, prefer `async/await`

2. **Forgetting to handle all union cases**
   - Problem: Switch statements without exhaustive checking
   - Solution: Add `default: assertNever(value)` check

3. **Mutating function parameters**
   - Problem: Side effects make code unpredictable
   - Solution: Create new objects/arrays instead

4. **Over-abstracting early**
   - Problem: Complex abstractions for simple problems
   - Solution: Wait for patterns to emerge before abstracting

## Biome Configuration

The project uses Biome for linting and formatting. Key settings:

```jsonc
{
  "linter": {
    "rules": {
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      },
      "style": {
        "useConst": "error",
        "useTemplate": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "formatter": {
    "indentStyle": "tab",
    "lineWidth": 100
  }
}
```

Run `pnpm lint` to check and `pnpm format` to auto-fix.

## Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
- [Biome Documentation](https://biomejs.dev/)
- [Clean Code TypeScript](https://github.com/labs42io/clean-code-typescript)

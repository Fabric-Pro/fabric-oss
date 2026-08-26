# Development Conventions

## Overview

This document establishes project-wide conventions for the Fabric Portal codebase. Following these conventions ensures consistency and maintainability across the monorepo.

## When to Apply

- Starting new features
- Creating new files or directories
- Setting up development environment
- Contributing to the codebase

## Core Principles

1. **Convention over Configuration** - Follow established patterns
2. **Workspace Packages** - Leverage the monorepo structure
3. **Type Safety** - End-to-end type inference
4. **Colocation** - Keep related code together

## ✅ DO

### Project Structure

**✅ DO**: Follow the established directory structure

```
fabric/
├── apps/
│   └── web/                          # Next.js application
│       ├── app/                      # App Router pages
│       │   ├── (marketing)/          # Public marketing pages
│       │   ├── (saas)/               # Authenticated app pages
│       │   └── api/                  # API route handlers
│       └── modules/                  # Feature modules
│           ├── saas/                 # SaaS feature components
│           │   ├── workflows/        # Workflow builder
│           │   ├── agents/           # AI agents
│           │   └── projects/         # Project management
│           ├── marketing/            # Marketing components
│           ├── shared/               # Shared components/hooks
│           └── ui/                   # Shadcn UI components
├── packages/
│   ├── api/                          # oRPC API routes
│   ├── auth/                         # Authentication
│   ├── database/                     # Prisma schema & queries
│   ├── temporal/                     # Durable workflows
│   └── ...                           # Other shared packages
├── config/                           # App configuration
└── fabric/standards/                 # This documentation
```

**✅ DO**: Use workspace package imports

```typescript
// Good: Use @repo/* for workspace packages
import { db } from "@repo/database";
import { auth } from "@repo/auth";
import { protectedProcedure } from "@repo/api/orpc/procedures";

// Good: Use path aliases for app-level imports
import { Button } from "@ui/components/button";
import { useSession } from "@saas/auth/hooks/use-session";
import { WorkflowBuilder } from "@saas/workflows/components/WorkflowBuilder";
```

### File Naming

**✅ DO**: Follow consistent file naming patterns

```
# Components: PascalCase.tsx
WorkflowBuilder.tsx
NodeConfigEditor.tsx
UserProfileCard.tsx

# Hooks: use-kebab-case.ts
use-session.ts
use-workflow-actions.ts
use-ai-models.ts

# Utilities/Libraries: kebab-case.ts
format-duration.ts
api-client.ts
node-definitions.ts

# API Procedures: kebab-case.ts
create-workflow.ts
list-workflows.ts
get-execution-stats.ts

# Types: kebab-case.ts or types.ts
types.ts
workflow-types.ts

# Tests: *.test.ts or *.test.tsx
WorkflowBuilder.test.tsx
create-workflow.test.ts
```

### API Route Organization

**✅ DO**: Organize oRPC procedures by domain

```
packages/api/
├── orpc/
│   ├── procedures.ts      # Base procedures (public, protected, admin)
│   ├── router.ts          # Main router combining all modules
│   └── handler.ts         # Hono handler setup
└── modules/
    ├── workflows/
    │   ├── router.ts      # Workflows router export
    │   └── procedures/
    │       ├── create-workflow.ts
    │       ├── list-workflows.ts
    │       ├── executions/
    │       │   ├── list-executions.ts
    │       │   └── start-execution.ts
    │       └── publish/
    │           ├── index.ts
    │           ├── publish-workflow.ts
    │           └── unpublish-workflow.ts
    └── users/
        ├── router.ts
        └── procedures/
            └── ...
```

**✅ DO**: Use nested routers for related operations

```typescript
// packages/api/modules/workflows/router.ts
export const workflowsRouter = {
  // CRUD operations at root level
  list: listWorkflowsProcedure,
  get: getWorkflowProcedure,
  create: createWorkflowProcedure,
  update: updateWorkflowProcedure,
  delete: deleteWorkflowProcedure,

  // Related operations nested
  publish: {
    publish: publishWorkflow,
    unpublish: unpublishWorkflow,
    rollback: rollbackWorkflow,
  },

  executions: {
    list: listWorkflowExecutionsProcedure,
    get: getWorkflowExecutionProcedure,
    start: startWorkflowExecutionProcedure,
  },
};
```

### Environment Variables

**✅ DO**: Follow environment variable conventions

```bash
# .env.local (never committed)

# Database
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

# Public (exposed to browser)
NEXT_PUBLIC_SITE_URL="http://localhost:3001"
NEXT_PUBLIC_AVATARS_BUCKET_NAME="avatars"

# Private (server-only)
BETTER_AUTH_SECRET="..."
AWS_ACCESS_KEY_ID="..."
STRIPE_SECRET_KEY="..."
OPENAI_API_KEY="..."
```

**✅ DO**: Validate environment variables at startup

```typescript
// config/index.ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
});

export const env = envSchema.parse(process.env);
```

### Git Conventions

**✅ DO**: Use conventional commit messages

```bash
# Format: type(scope): description

feat(workflows): add workflow version history
fix(auth): handle expired session gracefully
docs(standards): update API conventions
refactor(api): extract membership verification
chore(deps): update @tanstack/react-query to 5.90.6
test(workflows): add integration tests for publish
```

**✅ DO**: Create focused, atomic commits

```bash
# Good: One logical change per commit
git commit -m "feat(workflows): add publish workflow endpoint"
git commit -m "feat(workflows): add unpublish workflow endpoint"
git commit -m "feat(workflows): add publish dialog UI"

# Bad: Mixing unrelated changes
git commit -m "add workflow features and fix auth and update deps"
```

## ❌ DON'T

### Anti-Patterns

**❌ DON'T**: Import from package internals

```typescript
// Bad: Importing from deep paths
import { db } from "@repo/database/prisma/client";
import { validateUser } from "@repo/auth/lib/validation";

// Good: Import from package entry points
import { db } from "@repo/database";
import { auth } from "@repo/auth";
```
**Why**: Internal paths may change; entry points are stable APIs.

**❌ DON'T**: Create circular dependencies

```typescript
// Bad: api imports from web, web imports from api
// packages/api/modules/workflows/lib.ts
import { formatDuration } from "@repo/web/modules/saas/workflows/lib/format-duration";

// Good: Extract shared code to a package
// packages/utils/lib/format-duration.ts
export function formatDuration(ms: number): string { ... }
```
**Why**: Circular deps cause build failures and runtime issues.

**❌ DON'T**: Commit sensitive data

```typescript
// Bad: Hardcoded secrets
const API_KEY = "sk-1234567890abcdef";

// Bad: Checked-in .env files
// .env.local committed to git

// Good: Use environment variables
const API_KEY = process.env.OPENAI_API_KEY;
```
**Why**: Security vulnerability; secrets get into git history.

**❌ DON'T**: Skip the package manager

```bash
# Bad: Manually editing package.json
# Then running pnpm install

# Good: Use pnpm commands
pnpm add zod
pnpm add -D vitest
pnpm --filter @repo/database add prisma
```
**Why**: Manual edits can cause version conflicts and lockfile issues.

## Patterns & Examples

### Pattern 1: Feature Module Structure

**Use Case**: Adding a new feature (e.g., "prompts")

```
apps/web/modules/saas/prompts/
├── components/
│   ├── PromptList.tsx
│   ├── PromptEditor.tsx
│   ├── PromptCard.tsx
│   └── CreatePromptDialog.tsx
├── hooks/
│   └── usePromptActions.ts
├── lib/
│   ├── types.ts
│   └── validation.ts
└── index.ts                    # Public exports

packages/api/modules/prompts/
├── router.ts
└── procedures/
    ├── create-prompt.ts
    ├── list-prompts.ts
    ├── update-prompt.ts
    └── delete-prompt.ts

packages/database/prisma/queries/
└── prompts.ts                  # Database queries
```

### Pattern 2: Route Group Organization

**Use Case**: Organizing Next.js App Router pages

```
apps/web/app/
├── (marketing)/               # Public pages (no auth required)
│   ├── page.tsx               # Landing page
│   ├── pricing/page.tsx
│   └── blog/page.tsx
├── (saas)/                    # Protected pages (auth required)
│   └── app/
│       ├── layout.tsx         # Dashboard layout with sidebar
│       ├── page.tsx           # Dashboard home
│       ├── workflows/
│       │   ├── page.tsx       # Workflow list
│       │   └── [id]/
│       │       └── page.tsx   # Workflow editor
│       └── settings/
│           └── page.tsx
├── auth/                      # Auth pages
│   ├── login/page.tsx
│   └── signup/page.tsx
└── api/                       # API routes
    ├── [[...route]]/route.ts  # oRPC handler
    └── webhooks/
        └── stripe/route.ts
```

### Pattern 3: Database Query Organization

**Use Case**: Keeping database queries organized and type-safe

```typescript
// packages/database/prisma/queries/workflows.ts
import { db } from "../client";
import type { Prisma } from "../generated";

export async function createWorkflow(
  data: Prisma.WorkflowCreateInput,
): Promise<Workflow> {
  return await db.workflow.create({ data });
}

export async function getWorkflowById(id: string): Promise<Workflow | null> {
  return await db.workflow.findUnique({ where: { id } });
}

export async function listWorkflows(params: {
  userId: string;
  organizationId?: string;
  limit?: number;
  offset?: number;
}): Promise<Workflow[]> {
  return await db.workflow.findMany({
    where: {
      userId: params.userId,
      organizationId: params.organizationId,
    },
    take: params.limit ?? 20,
    skip: params.offset ?? 0,
    orderBy: { updatedAt: "desc" },
  });
}

// Re-export from package index
// packages/database/index.ts
export * from "./prisma/queries/workflows";
```

## Common Mistakes

1. **Creating new root-level directories**
   - Problem: Code outside established structure
   - Solution: Use existing `packages/`, `apps/`, or `config/`

2. **Mixing feature code across modules**
   - Problem: Workflow code in agents module
   - Solution: Keep feature code colocated

3. **Inconsistent casing**
   - Problem: `UserProfile.tsx` vs `user-profile.tsx`
   - Solution: Components = PascalCase, utilities = kebab-case

4. **Skipping workspace package**
   - Problem: Duplicating database client in multiple places
   - Solution: Use `@repo/database` everywhere

## Monorepo Commands

```bash
# Development
pnpm dev                          # Start all dev servers
pnpm --filter web dev             # Start only web app
pnpm --filter @repo/database dev  # Start only database watchers

# Building
pnpm build                        # Build all packages
pnpm --filter web build           # Build only web app

# Type checking
pnpm type-check                   # Check all packages

# Linting
pnpm lint                         # Lint all packages
pnpm format                       # Format all packages

# Database
pnpm --filter @repo/database generate  # Generate Prisma client
pnpm --filter @repo/database push      # Push schema to database
pnpm --filter @repo/database studio    # Open Prisma Studio

# Testing
pnpm --filter web test            # Run unit tests
pnpm --filter web e2e             # Run E2E tests (UI mode)
```

## Resources

- [pnpm Workspaces](https://pnpm.io/workspaces)
- [Turborepo Docs](https://turbo.build/repo/docs)
- [Next.js App Router](https://nextjs.org/docs/app)
- [Conventional Commits](https://www.conventionalcommits.org/)

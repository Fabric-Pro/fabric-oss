# Testing Standards

## Overview

This document defines testing standards for the Fabric Portal. Tests ensure code quality, catch regressions, and document expected behavior.

## When to Apply

- Writing new features
- Fixing bugs (add regression tests)
- Refactoring code
- Code reviews

## Core Principles

1. **Test Behavior, Not Implementation** - Focus on what code does, not how
2. **Arrange-Act-Assert** - Clear test structure
3. **Fast and Isolated** - Tests run quickly and independently
4. **Meaningful Coverage** - Cover critical paths, not just lines

## Test Stack

| Tool | Purpose |
|------|---------|
| **Vitest** | Unit and integration tests |
| **React Testing Library** | Component testing |
| **Playwright** | End-to-end tests |
| **MSW** | API mocking (when needed) |

## ✅ DO

### Unit Tests with Vitest

**✅ DO**: Write focused unit tests

```typescript
// packages/api/modules/workflows/procedures/__tests__/create-workflow.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createWorkflowProcedure } from "../create-workflow";
import { db } from "@repo/database";

// Mock database
vi.mock("@repo/database", () => ({
  db: {
    workflow: {
      create: vi.fn(),
    },
  },
}));

describe("createWorkflowProcedure", () => {
  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    role: "user",
  };

  const mockContext = {
    user: mockUser,
    session: { id: "session-1" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a workflow with valid input", async () => {
    const mockWorkflow = {
      id: "workflow-1",
      name: "Test Workflow",
      userId: mockUser.id,
      status: "DRAFT",
    };

    vi.mocked(db.workflow.create).mockResolvedValue(mockWorkflow);

    const result = await createWorkflowProcedure.handler({
      input: { name: "Test Workflow" },
      context: mockContext,
    });

    expect(result.workflow).toEqual(mockWorkflow);
    expect(db.workflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Test Workflow",
        userId: mockUser.id,
      }),
    });
  });

  it("throws FORBIDDEN when user is not organization member", async () => {
    await expect(
      createWorkflowProcedure.handler({
        input: { name: "Test", organizationId: "org-not-member" },
        context: mockContext,
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
});
```

### Component Tests with React Testing Library

**✅ DO**: Test component behavior from user perspective

```tsx
// apps/web/modules/saas/workflows/components/__tests__/WorkflowCard.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowCard } from "../WorkflowCard";

describe("WorkflowCard", () => {
  const mockWorkflow = {
    id: "workflow-1",
    name: "My Workflow",
    description: "Test description",
    status: "DRAFT",
    updatedAt: new Date("2024-01-15"),
  };

  it("renders workflow name and description", () => {
    render(<WorkflowCard workflow={mockWorkflow} />);

    expect(screen.getByText("My Workflow")).toBeInTheDocument();
    expect(screen.getByText("Test description")).toBeInTheDocument();
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
  });

  it("calls onDelete when delete is clicked", async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();

    render(<WorkflowCard workflow={mockWorkflow} onDelete={onDelete} />);

    // Open dropdown menu
    await user.click(screen.getByRole("button", { name: /more/i }));
    
    // Click delete option
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith("workflow-1");
  });

  it("navigates to workflow editor on click", () => {
    render(<WorkflowCard workflow={mockWorkflow} />);

    const link = screen.getByRole("link", { name: "My Workflow" });
    expect(link).toHaveAttribute("href", "/app/workflows/workflow-1");
  });

  it("shows run button for published workflows", () => {
    render(
      <WorkflowCard
        workflow={{ ...mockWorkflow, status: "PUBLISHED" }}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
  });
});
```

### Hook Tests

**✅ DO**: Test custom hooks in isolation

```tsx
// apps/web/modules/saas/workflows/hooks/__tests__/useWorkflowActions.test.tsx
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateWorkflow } from "../useWorkflowActions";

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe("useCreateWorkflow", () => {
  it("creates workflow and invalidates cache", async () => {
    const { result } = renderHook(() => useCreateWorkflow(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ name: "New Workflow" });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.workflow.name).toBe("New Workflow");
  });

  it("handles error state", async () => {
    // Mock API to fail
    vi.mock("@/lib/api-client", () => ({
      api: {
        workflows: {
          create: vi.fn().mockRejectedValue(new Error("Network error")),
        },
      },
    }));

    const { result } = renderHook(() => useCreateWorkflow(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ name: "New Workflow" });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe("Network error");
  });
});
```

### E2E Tests with Playwright

**✅ DO**: Test critical user journeys

```typescript
// apps/web/tests/workflows.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Workflow Builder", () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto("/auth/login");
    await page.fill('[name="email"]', "test@example.com");
    await page.fill('[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL("/app");
  });

  test("creates a new workflow", async ({ page }) => {
    // Navigate to workflows
    await page.goto("/app/workflows");

    // Click create button
    await page.click('button:has-text("Create Workflow")');

    // Fill in workflow details
    await page.fill('[name="name"]', "E2E Test Workflow");
    await page.fill('[name="description"]', "Created by Playwright");
    await page.click('button:has-text("Create")');

    // Verify redirect to editor
    await expect(page).toHaveURL(/\/app\/workflows\/[\w-]+/);

    // Verify workflow name is displayed
    await expect(page.getByText("E2E Test Workflow")).toBeVisible();
  });

  test("adds and configures a node", async ({ page }) => {
    await page.goto("/app/workflows/test-workflow-id");

    // Add a node
    await page.click('button[title="Add action"]');

    // Select AI Generate Text action
    await page.click('button:has-text("AI Generate Text")');

    // Configure the node
    await page.fill('[name="prompt"]', "Generate a summary");
    await page.selectOption('[name="model"]', "gpt-4");

    // Save workflow
    await page.click('button:has-text("Save")');

    // Verify save toast
    await expect(page.getByText("Workflow saved")).toBeVisible();
  });

  test("runs a workflow and shows execution history", async ({ page }) => {
    await page.goto("/app/workflows/published-workflow-id");

    // Click run
    await page.click('button:has-text("Run")');

    // Wait for execution to start
    await expect(page.getByText("Execution started")).toBeVisible();

    // Open run history
    await page.click('button:has-text("Show Runs")');

    // Verify execution appears
    await expect(page.getByText("Running")).toBeVisible({ timeout: 10000 });
  });
});
```

### Test Organization

**✅ DO**: Organize tests consistently

```
apps/web/
├── __tests__/                    # Integration tests
│   ├── api/
│   │   └── mcp-configs.integration.test.ts
│   └── workflows/
│       └── integrations.test.ts
├── modules/
│   └── saas/
│       └── workflows/
│           └── components/
│               └── __tests__/    # Component tests (colocated)
│                   └── WorkflowCard.test.tsx
└── tests/                        # E2E tests
    ├── auth.setup.ts
    ├── workflows.spec.ts
    └── agents.spec.ts

packages/
├── api/
│   └── modules/
│       └── workflows/
│           └── procedures/
│               └── __tests__/    # Procedure tests (colocated)
└── temporal/
    └── __tests__/
        └── workflow-integrations.test.ts
```

## ❌ DON'T

### Testing Implementation Details

**❌ DON'T**: Test internal state or implementation

```tsx
// Bad: Testing internal state
it("updates internal state correctly", () => {
  const { result } = renderHook(() => useWorkflowBuilder());
  
  // ❌ Don't access internal state directly
  expect(result.current._internalNodes.length).toBe(0);
});
```
**Why**: Breaks when refactoring, doesn't test actual behavior.

**✅ Better**:

```tsx
// Good: Test observable behavior
it("adds a node when addNode is called", () => {
  render(<WorkflowBuilder />);
  
  // Test what user sees/does
  fireEvent.click(screen.getByText("Add Node"));
  expect(screen.getByText("New Node")).toBeInTheDocument();
});
```

### Flaky Tests

**❌ DON'T**: Write tests that depend on timing

```typescript
// Bad: Arbitrary delays
it("shows loading then data", async () => {
  render(<WorkflowList />);
  
  // ❌ Arbitrary timeout
  await new Promise(r => setTimeout(r, 1000));
  
  expect(screen.getByText("My Workflow")).toBeInTheDocument();
});
```
**Why**: Flaky, slow, may fail in CI.

**✅ Better**:

```typescript
// Good: Wait for specific conditions
it("shows loading then data", async () => {
  render(<WorkflowList />);
  
  // ✅ Wait for loading to disappear
  await waitForElementToBeRemoved(() => screen.queryByText("Loading..."));
  
  // ✅ Or wait for element to appear
  await waitFor(() => {
    expect(screen.getByText("My Workflow")).toBeInTheDocument();
  });
});
```

### Over-Mocking

**❌ DON'T**: Mock everything

```typescript
// Bad: Too many mocks, test doesn't verify real behavior
vi.mock("@repo/database");
vi.mock("@repo/auth");
vi.mock("@repo/utils");
vi.mock("./validation");
vi.mock("./helpers");

it("creates workflow", async () => {
  // Everything is mocked, test is meaningless
});
```
**Why**: Tests pass but real code might fail.

**✅ Better**:

```typescript
// Good: Mock only external boundaries
vi.mock("@repo/database"); // Mock database

it("creates workflow with proper validation", async () => {
  // Real validation code runs
  await expect(
    createWorkflow({ name: "" }),
  ).rejects.toThrow("Name is required");
});
```

## Patterns & Examples

### Pattern 1: Test Data Factories

**Use Case**: Consistent test data creation

```typescript
// tests/factories/workflow.ts
import { faker } from "@faker-js/faker";
import type { Workflow } from "@repo/database";

export function createWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: faker.string.uuid(),
    name: faker.commerce.productName(),
    description: faker.lorem.sentence(),
    status: "DRAFT",
    triggerType: "MANUAL",
    version: 1,
    userId: faker.string.uuid(),
    organizationId: null,
    nodes: [],
    edges: [],
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// Usage
const workflow = createWorkflow({ status: "PUBLISHED" });
```

### Pattern 2: Custom Render with Providers

**Use Case**: Components that need context

```tsx
// tests/utils/render.tsx
import { render, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

interface CustomRenderOptions extends RenderOptions {
  queryClient?: QueryClient;
}

export function customRender(
  ui: React.ReactElement,
  options: CustomRenderOptions = {},
) {
  const {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    }),
    ...renderOptions
  } = options;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider attribute="class" defaultTheme="light">
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

// Usage
import { customRender as render } from "@/tests/utils/render";

it("renders with providers", () => {
  render(<MyComponent />);
});
```

### Pattern 3: API Testing with Test Client

**Use Case**: Testing API procedures directly

```typescript
// tests/utils/test-client.ts
import { createClient } from "@orpc/client";
import { router } from "@repo/api";

export function createTestClient(options: {
  user?: User;
  session?: Session;
}) {
  const headers = new Headers();
  
  if (options.user) {
    // Set auth headers for testing
    headers.set("x-test-user-id", options.user.id);
  }

  return createClient(router, {
    context: { headers },
  });
}

// Usage
it("lists user workflows", async () => {
  const client = createTestClient({ user: testUser });
  
  const result = await client.workflows.list({});
  
  expect(result.workflows).toHaveLength(3);
});
```

### Pattern 4: Playwright Page Objects

**Use Case**: Reusable E2E test helpers

```typescript
// tests/pages/workflow-editor.ts
import { type Page, expect } from "@playwright/test";

export class WorkflowEditorPage {
  constructor(private page: Page) {}

  async goto(workflowId: string) {
    await this.page.goto(`/app/workflows/${workflowId}`);
  }

  async addNode(nodeType: string) {
    await this.page.click('button[title="Add action"]');
    await this.page.click(`button:has-text("${nodeType}")`);
  }

  async save() {
    await this.page.click('button:has-text("Save")');
    await expect(this.page.getByText("Workflow saved")).toBeVisible();
  }

  async run() {
    await this.page.click('button:has-text("Run")');
    await expect(this.page.getByText("Execution started")).toBeVisible();
  }

  async setNodeConfig(nodeId: string, config: Record<string, string>) {
    await this.page.click(`[data-node-id="${nodeId}"]`);
    for (const [name, value] of Object.entries(config)) {
      await this.page.fill(`[name="${name}"]`, value);
    }
  }
}

// Usage in test
test("creates and runs workflow", async ({ page }) => {
  const editor = new WorkflowEditorPage(page);
  
  await editor.goto("new");
  await editor.addNode("AI Generate Text");
  await editor.setNodeConfig("ai-1", { prompt: "Hello world" });
  await editor.save();
  await editor.run();
});
```

## Coverage Configuration

```typescript
// apps/web/vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "tests/",         // E2E tests
        "**/*.config.*",
        ".next/",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
```

## Running Tests

```bash
# Unit tests
pnpm --filter web test              # Watch mode
pnpm --filter web test --run        # Single run
pnpm --filter web test:coverage     # With coverage

# E2E tests
pnpm --filter web e2e               # UI mode
pnpm --filter web e2e:ci            # Headless CI mode
```

## Common Mistakes

1. **Not cleaning up after tests**
   - Problem: Tests affect each other
   - Solution: Use `beforeEach`/`afterEach` cleanup

2. **Testing library code**
   - Problem: Testing React Query, Prisma internals
   - Solution: Focus on your code's behavior

3. **Skipping edge cases**
   - Problem: Bugs in error paths
   - Solution: Test error states, empty states, loading

4. **Snapshot overuse**
   - Problem: Large, brittle snapshots
   - Solution: Use sparingly, prefer explicit assertions

## Resources

- [Vitest Documentation](https://vitest.dev)
- [Testing Library](https://testing-library.com)
- [Playwright Documentation](https://playwright.dev)
- [Testing JavaScript (Kent C. Dodds)](https://testingjavascript.com)

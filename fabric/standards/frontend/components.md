# React Component Standards

## Overview

This document defines standards for building React components in the Fabric Portal. Components should be composable, accessible, and follow React 19 best practices.

## When to Apply

- Creating new UI components
- Refactoring existing components
- Building feature modules
- Creating reusable UI primitives

## Core Principles

1. **Server-First** - Prefer Server Components, use Client Components only when needed
2. **Composition** - Build complex UIs from simple, composable parts
3. **Accessibility** - Components must be keyboard and screen-reader friendly
4. **Type Safety** - Full TypeScript coverage with explicit props

## ✅ DO

### Server vs Client Components

**✅ DO**: Use Server Components by default

```tsx
// app/(saas)/app/workflows/page.tsx
// Server Component - no "use client" directive
import { db } from "@repo/database";
import { auth } from "@repo/auth";
import { WorkflowGrid } from "@saas/workflows/components/WorkflowGrid";

export default async function WorkflowsPage() {
  const session = await auth();
  
  const workflows = await db.workflow.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div className="container py-8">
      <h1 className="text-2xl font-bold mb-6">Workflows</h1>
      <WorkflowGrid workflows={workflows} />
    </div>
  );
}
```

**✅ DO**: Use Client Components only when necessary

```tsx
// modules/saas/workflows/components/WorkflowBuilder.tsx
"use client";  // Only when you need interactivity

import { useState, useCallback } from "react";
import { ReactFlow, useNodesState, useEdgesState } from "@xyflow/react";

export function WorkflowBuilder({ initialNodes, initialEdges }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  
  // Interactive state and handlers...
  
  return <ReactFlow nodes={nodes} edges={edges} />;
}
```

**When to use "use client":**
- useState, useEffect, useRef hooks
- Event handlers (onClick, onChange)
- Browser APIs (localStorage, window)
- Third-party client libraries

### Component Structure

**✅ DO**: Follow consistent component organization

```tsx
// modules/saas/workflows/components/WorkflowCard.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontalIcon, PlayIcon, EditIcon, TrashIcon } from "lucide-react";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { DropdownMenu, DropdownMenuItem } from "@ui/components/dropdown-menu";
import { Badge } from "@ui/components/badge";
import type { Workflow } from "@repo/database";

// 1. Props interface
interface WorkflowCardProps {
  workflow: Workflow;
  onDelete?: (id: string) => void;
  onRun?: (id: string) => void;
}

// 2. Component with named export
export function WorkflowCard({ workflow, onDelete, onRun }: WorkflowCardProps) {
  // 3. State and hooks first
  const [isDeleting, setIsDeleting] = useState(false);

  // 4. Event handlers
  const handleDelete = async () => {
    setIsDeleting(true);
    await onDelete?.(workflow.id);
    setIsDeleting(false);
  };

  // 5. Derived values
  const statusColor = {
    DRAFT: "secondary",
    PUBLISHED: "default",
    ACTIVE: "success",
    ARCHIVED: "muted",
  }[workflow.status] ?? "secondary";

  // 6. Render
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">
          <Link href={`/app/workflows/${workflow.id}`}>
            {workflow.name}
          </Link>
        </CardTitle>
        <Badge variant={statusColor}>{workflow.status}</Badge>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground line-clamp-2">
          {workflow.description || "No description"}
        </p>
        <div className="flex items-center justify-between mt-4">
          <span className="text-xs text-muted-foreground">
            Updated {formatDistanceToNow(workflow.updatedAt)} ago
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRun?.(workflow.id)}
            >
              <PlayIcon className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <MoreHorizontalIcon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem asChild>
                  <Link href={`/app/workflows/${workflow.id}`}>
                    <EditIcon className="h-4 w-4 mr-2" />
                    Edit
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="text-destructive"
                >
                  <TrashIcon className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

### Props Design

**✅ DO**: Use explicit, typed props

```tsx
// Good: Explicit interface with optional handlers
interface NodeConfigEditorProps {
  node: WorkflowNode;
  onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
  onDelete: (nodeId: string) => void;
  className?: string;
}

// Good: Extend HTML element props
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "destructive";
  size?: "sm" | "default" | "lg" | "icon";
  isLoading?: boolean;
}

// Good: Use discriminated unions for variants
type AlertProps =
  | { variant: "success"; onDismiss?: () => void }
  | { variant: "error"; error: Error; onRetry?: () => void }
  | { variant: "warning"; message: string };
```

### Shadcn UI Usage

**✅ DO**: Use and extend Shadcn UI components

```tsx
// modules/ui/components/button.tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@ui/lib";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

### State Management with TanStack Query

**✅ DO**: Use TanStack Query for server state

```tsx
// modules/saas/workflows/hooks/useWorkflows.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

// Query keys as constants for consistency
export const workflowKeys = {
  all: ["workflows"] as const,
  lists: () => [...workflowKeys.all, "list"] as const,
  list: (filters: WorkflowFilters) => [...workflowKeys.lists(), filters] as const,
  details: () => [...workflowKeys.all, "detail"] as const,
  detail: (id: string) => [...workflowKeys.details(), id] as const,
};

export function useWorkflows(organizationId?: string) {
  return useQuery({
    queryKey: workflowKeys.list({ organizationId }),
    queryFn: () => api.workflows.list({ organizationId }),
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    queryKey: workflowKeys.detail(id),
    queryFn: () => api.workflows.get({ id }),
    enabled: !!id,
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateWorkflowInput) => api.workflows.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      toast.success("Workflow created");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create workflow");
    },
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.workflows.delete({ id }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      queryClient.removeQueries({ queryKey: workflowKeys.detail(id) });
      toast.success("Workflow deleted");
    },
  });
}
```

### Accessibility

**✅ DO**: Build accessible components

```tsx
// Good: Accessible dialog with proper ARIA
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui/components/dialog";

export function DeleteWorkflowDialog({ workflow, onDelete }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete workflow?</DialogTitle>
          <DialogDescription>
            This will permanently delete "{workflow.name}". This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

## ❌ DON'T

### Unnecessary Client Components

**❌ DON'T**: Make components client-side without reason

```tsx
// Bad: Client component for static content
"use client";

export function WorkflowHeader({ title }: { title: string }) {
  return <h1 className="text-2xl font-bold">{title}</h1>;
}
```
**Why**: Increases bundle size, loses RSC benefits.

### Prop Drilling

**❌ DON'T**: Pass props through many levels

```tsx
// Bad: Props passed through 4+ levels
<App user={user}>
  <Dashboard user={user}>
    <Sidebar user={user}>
      <UserMenu user={user} />
    </Sidebar>
  </Dashboard>
</App>
```
**Why**: Makes refactoring hard, components tightly coupled.

**✅ Better**: Use context or composition

```tsx
// Good: Context for shared state
const UserContext = createContext<User | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
  const { data: user } = useSession();
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export function useUser() {
  const user = useContext(UserContext);
  if (!user) throw new Error("useUser must be used within UserProvider");
  return user;
}
```

### Inline Styles and Classes

**❌ DON'T**: Use inline styles or hardcoded colors

```tsx
// Bad: Inline styles
<div style={{ color: "#3b82f6", padding: "16px" }}>

// Bad: Hardcoded colors
<div className="bg-[#3b82f6] text-[#ffffff]">
```
**Why**: Breaks theming, inconsistent with design system.

**✅ Better**: Use Tailwind tokens

```tsx
// Good: Semantic color tokens
<div className="bg-primary text-primary-foreground p-4">

// Good: Using CSS variables via Tailwind
<div className="bg-background text-foreground">
```

### God Components

**❌ DON'T**: Create components that do too much

```tsx
// Bad: 500+ line component
export function WorkflowBuilderWithHistoryAndSettingsAndExecution() {
  // Hundreds of lines of mixed concerns...
}
```
**Why**: Hard to test, maintain, and understand.

**✅ Better**: Compose smaller components

```tsx
// Good: Composed from focused components
export function WorkflowBuilder(props: WorkflowBuilderProps) {
  return (
    <WorkflowProvider workflow={props.workflow}>
      <div className="flex h-full">
        <WorkflowCanvas />
        <WorkflowSidebar>
          <WorkflowProperties />
          <WorkflowActions />
          <WorkflowIntegrations />
        </WorkflowSidebar>
      </div>
    </WorkflowProvider>
  );
}
```

## Patterns & Examples

### Pattern 1: Compound Components

**Use Case**: Related components that work together

```tsx
// Tab component with compound pattern
const TabsContext = createContext<TabsContextValue | null>(null);

export function Tabs({ children, defaultValue }: TabsProps) {
  const [value, setValue] = useState(defaultValue);
  
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className="w-full">{children}</div>
    </TabsContext.Provider>
  );
}

Tabs.List = function TabsList({ children }: { children: ReactNode }) {
  return <div className="flex border-b">{children}</div>;
};

Tabs.Trigger = function TabsTrigger({ value, children }: TriggerProps) {
  const ctx = useContext(TabsContext)!;
  return (
    <button
      onClick={() => ctx.setValue(value)}
      className={cn(
        "px-4 py-2",
        ctx.value === value && "border-b-2 border-primary",
      )}
    >
      {children}
    </button>
  );
};

Tabs.Content = function TabsContent({ value, children }: ContentProps) {
  const ctx = useContext(TabsContext)!;
  if (ctx.value !== value) return null;
  return <div className="py-4">{children}</div>;
};

// Usage
<Tabs defaultValue="properties">
  <Tabs.List>
    <Tabs.Trigger value="properties">Properties</Tabs.Trigger>
    <Tabs.Trigger value="actions">Actions</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="properties">...</Tabs.Content>
  <Tabs.Content value="actions">...</Tabs.Content>
</Tabs>
```

### Pattern 2: Render Props for Flexibility

**Use Case**: Components with customizable rendering

```tsx
interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  renderRow?: (item: T, index: number) => ReactNode;
  renderEmpty?: () => ReactNode;
}

export function DataTable<T>({
  data,
  columns,
  renderRow,
  renderEmpty,
}: DataTableProps<T>) {
  if (data.length === 0) {
    return renderEmpty?.() ?? <EmptyState />;
  }

  return (
    <table>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.id}>{col.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((item, index) =>
          renderRow ? (
            renderRow(item, index)
          ) : (
            <tr key={index}>
              {columns.map((col) => (
                <td key={col.id}>{col.cell(item)}</td>
              ))}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
```

### Pattern 3: Loading and Error States

**Use Case**: Consistent loading/error UI

```tsx
interface AsyncBoundaryProps {
  isLoading: boolean;
  error?: Error | null;
  children: ReactNode;
  loadingFallback?: ReactNode;
  errorFallback?: (error: Error) => ReactNode;
}

export function AsyncBoundary({
  isLoading,
  error,
  children,
  loadingFallback,
  errorFallback,
}: AsyncBoundaryProps) {
  if (isLoading) {
    return loadingFallback ?? <LoadingSpinner />;
  }

  if (error) {
    return errorFallback?.(error) ?? <ErrorMessage error={error} />;
  }

  return <>{children}</>;
}

// Usage
export function WorkflowList() {
  const { data, isLoading, error } = useWorkflows();

  return (
    <AsyncBoundary
      isLoading={isLoading}
      error={error}
      loadingFallback={<WorkflowListSkeleton />}
    >
      <div className="grid gap-4">
        {data?.workflows.map((workflow) => (
          <WorkflowCard key={workflow.id} workflow={workflow} />
        ))}
      </div>
    </AsyncBoundary>
  );
}
```

## Common Mistakes

1. **Forgetting key prop in lists**
   - Problem: React can't track items, causes bugs
   - Solution: Always use unique, stable keys

2. **State updates in render**
   - Problem: Infinite loops
   - Solution: Use useEffect or event handlers

3. **Missing dependency arrays**
   - Problem: Stale closures or infinite effects
   - Solution: Include all dependencies, use eslint-plugin-react-hooks

4. **Not handling unmounted state**
   - Problem: State updates after unmount
   - Solution: Check mounted state or use AbortController

## Resources

- [React 19 Documentation](https://react.dev)
- [Next.js App Router](https://nextjs.org/docs/app)
- [Shadcn UI Components](https://ui.shadcn.com)
- [Radix UI Primitives](https://www.radix-ui.com)
- [TanStack Query](https://tanstack.com/query)

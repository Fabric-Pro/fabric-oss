# Deployment Standards

## Overview

This document defines deployment standards for the Fabric Portal. Proper deployment practices ensure reliability, scalability, and zero-downtime updates.

## When to Apply

- Deploying to production
- Setting up CI/CD pipelines
- Configuring infrastructure
- Managing environment variables

## Core Principles

1. **Infrastructure as Code** - All infra changes are versioned
2. **Zero Downtime** - Rolling updates without service interruption
3. **Reproducibility** - Same code produces same deployment
4. **Observability** - Full visibility into deployment state

## ✅ DO

### Environment Configuration

**✅ DO**: Use environment-specific configuration

```bash
# .env.local (local development - never committed)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fabric"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/fabric"
NEXT_PUBLIC_SITE_URL="http://localhost:3001"
BETTER_AUTH_SECRET="dev-secret-at-least-32-characters"
OPENAI_API_KEY="sk-..."

# Environment variable naming conventions
# - NEXT_PUBLIC_* = exposed to browser
# - *_SECRET, *_KEY, *_PASSWORD = sensitive, never log
# - DATABASE_URL = primary connection string
# - DIRECT_URL = direct connection (for migrations)
```

**✅ DO**: Validate environment at startup

```typescript
// config/env.ts
import { z } from "zod";

const envSchema = z.object({
  // Required
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  
  // Optional with defaults
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  
  // AI providers (at least one required in production)
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
}).refine(
  (data) => {
    if (data.NODE_ENV === "production") {
      return data.OPENAI_API_KEY || data.ANTHROPIC_API_KEY;
    }
    return true;
  },
  { message: "At least one AI provider key required in production" },
);

export const env = envSchema.parse(process.env);
```

### Local Development with Aspire

**✅ DO**: Use .NET Aspire for local service orchestration

```bash
# Start all services with Aspire
./aspire.sh start

# Restart after code changes
./aspire.sh restart

# View logs
./aspire.sh logs

# Stop all services
./aspire.sh stop
```

```csharp
// aspire/Fabric.AppHost/Program.cs
var builder = DistributedApplication.CreateBuilder(args);

// Database
var postgres = builder.AddPostgres("postgres")
    .WithPgAdmin()
    .AddDatabase("fabric");

// Vector database
var qdrant = builder.AddContainer("qdrant", "qdrant/qdrant")
    .WithHttpEndpoint(port: 6333, targetPort: 6333);

// Temporal
var temporal = builder.AddContainer("temporal", "temporalio/auto-setup")
    .WithHttpEndpoint(port: 7233, targetPort: 7233);

// Web app
var web = builder.AddNpmApp("web", "../apps/web")
    .WithReference(postgres)
    .WithReference(qdrant)
    .WithReference(temporal)
    .WithHttpEndpoint(port: 3001);

builder.Build().Run();
```

### Database Migrations

**✅ DO**: Use Prisma migrations for schema changes

```bash
# Development: Push schema changes directly
pnpm --filter @repo/database push

# Production: Create and apply migrations
pnpm --filter @repo/database migrate:dev --name add_workflow_versions
pnpm --filter @repo/database migrate:deploy

# Generate Prisma client after schema changes
pnpm --filter @repo/database generate
```

**✅ DO**: Review migrations before applying

```sql
-- migrations/20240115_add_workflow_versions.sql
-- Review SQL before deploying

CREATE TABLE "workflow_version" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_version_workflowId_fkey" 
        FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "workflow_version_workflowId_version_key" 
    ON "workflow_version"("workflowId", "version");
```

### Build Configuration

**✅ DO**: Optimize production builds

```typescript
// apps/web/next.config.ts
import type { NextConfig } from "next";

const config: NextConfig = {
  // Output standalone for containerization
  output: "standalone",
  
  // Optimize images
  images: {
    remotePatterns: [
      { hostname: "*.amazonaws.com" },
    ],
  },
  
  // Reduce bundle size
  experimental: {
    optimizePackageImports: [
      "@radix-ui/react-icons",
      "lucide-react",
      "date-fns",
    ],
  },
  
  // Environment variables validation
  env: {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
};

export default config;
```

### Health Checks

**✅ DO**: Implement comprehensive health checks

```typescript
// packages/api/index.ts - Health check endpoint
app.get("/health", async (c) => {
  const checks: Record<string, { status: string; latency?: number }> = {};
  
  // Database check
  const dbStart = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = { status: "healthy", latency: Date.now() - dbStart };
  } catch {
    checks.database = { status: "unhealthy" };
  }
  
  // Temporal check
  const temporalStart = Date.now();
  try {
    const client = await getTemporalClient();
    await client.workflowService.getSystemInfo({});
    checks.temporal = { status: "healthy", latency: Date.now() - temporalStart };
  } catch {
    checks.temporal = { status: "unhealthy" };
  }
  
  // Qdrant check
  const qdrantStart = Date.now();
  try {
    await qdrantClient.getCollections();
    checks.qdrant = { status: "healthy", latency: Date.now() - qdrantStart };
  } catch {
    checks.qdrant = { status: "unhealthy" };
  }
  
  const allHealthy = Object.values(checks).every(c => c.status === "healthy");
  
  return c.json(
    { status: allHealthy ? "healthy" : "degraded", checks },
    allHealthy ? 200 : 503,
  );
});
```

## ❌ DON'T

### Hardcoded Configuration

**❌ DON'T**: Hardcode environment-specific values

```typescript
// Bad: Hardcoded URLs
const API_URL = "https://api.fabric.com";  // ❌
const DB_HOST = "prod-db.example.com";      // ❌
```
**Why**: Breaks in different environments.

**✅ Better**:

```typescript
// Good: Environment variables
const API_URL = process.env.NEXT_PUBLIC_API_URL;
const DB_HOST = process.env.DATABASE_URL;
```

### Manual Deployments

**❌ DON'T**: Deploy manually to production

```bash
# Bad: SSH into server and pull code
ssh prod-server
git pull origin main
npm run build
pm2 restart all
```
**Why**: Not reproducible, error-prone, no rollback.

### Secrets in Code

**❌ DON'T**: Commit secrets to version control

```typescript
// Bad: Secrets in code
const STRIPE_KEY = "sk_live_abc123...";  // ❌ NEVER DO THIS
```
**Why**: Exposed to anyone with repo access.

## Patterns & Examples

### Pattern 1: Feature Flags

**Use Case**: Gradual rollout of new features

```typescript
// config/feature-flags.ts
export const featureFlags = {
  workflows: {
    aiGeneration: process.env.FF_WORKFLOWS_AI === "true",
    scheduling: process.env.FF_WORKFLOWS_SCHEDULING === "true",
  },
  agents: {
    copilotKit: process.env.FF_AGENTS_COPILOT === "true",
    multiModel: process.env.FF_AGENTS_MULTI_MODEL === "true",
  },
};

// Usage in components
if (featureFlags.workflows.aiGeneration) {
  return <AIGenerationPanel />;
}
```

### Pattern 2: Graceful Shutdown

**Use Case**: Clean shutdown for zero-downtime deploys

```typescript
// packages/temporal/src/worker.ts
import { Worker } from "@temporalio/worker";

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: "main",
  });

  // Handle shutdown signals
  const shutdown = async () => {
    console.log("Shutting down worker...");
    await worker.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.run();
}
```

### Pattern 3: Blue-Green Deployment Check

**Use Case**: Verify new deployment before switching traffic

```typescript
// scripts/verify-deployment.ts
async function verifyDeployment(url: string): Promise<boolean> {
  const checks = [
    // Health check
    async () => {
      const res = await fetch(`${url}/health`);
      return res.ok;
    },
    // API responsiveness
    async () => {
      const res = await fetch(`${url}/api/health`);
      return res.ok && (await res.json()).status === "healthy";
    },
    // Critical page loads
    async () => {
      const res = await fetch(`${url}/auth/login`);
      return res.ok;
    },
  ];

  for (const check of checks) {
    if (!await check()) {
      return false;
    }
  }

  return true;
}
```

## Docker Configuration

```dockerfile
# Dockerfile
FROM node:22-alpine AS base
RUN corepack enable pnpm

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/*/package.json ./packages/
RUN pnpm install --frozen-lockfile

# Builder
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @repo/database generate
RUN pnpm --filter web build

# Runner
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

## Common Mistakes

1. **No rollback plan**
   - Problem: Bad deploy stays up
   - Solution: Always have previous version ready

2. **Deploying during peak hours**
   - Problem: Issues affect more users
   - Solution: Deploy during low-traffic periods

3. **Skipping staging**
   - Problem: Bugs found in production
   - Solution: Always test in staging first

4. **Large, infrequent deploys**
   - Problem: Hard to identify issues
   - Solution: Small, frequent deployments

## Deployment Checklist

- [ ] All tests passing
- [ ] Database migrations reviewed
- [ ] Environment variables configured
- [ ] Feature flags set appropriately
- [ ] Monitoring alerts configured
- [ ] Rollback plan documented
- [ ] Team notified of deployment

## Resources

- [.NET Aspire Documentation](https://learn.microsoft.com/en-us/dotnet/aspire/)
- [Prisma Migrations](https://www.prisma.io/docs/orm/prisma-migrate)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
- [Temporal Cloud](https://temporal.io/cloud)


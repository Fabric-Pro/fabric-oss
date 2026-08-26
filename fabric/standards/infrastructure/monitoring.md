# Monitoring Standards

## Overview

This document defines monitoring standards for the Fabric Portal. Effective monitoring enables quick issue detection, performance optimization, and data-driven decisions.

## When to Apply

- Adding new features or services
- Debugging production issues
- Performance tuning
- Capacity planning

## Core Principles

1. **Metrics First** - Measure everything important
2. **Alerts on Symptoms** - Alert on user impact, not causes
3. **Distributed Tracing** - Follow requests across services
4. **Structured Logging** - Queryable, contextual logs

## Monitoring Stack

| Component | Tool | Purpose |
|-----------|------|---------|
| **Metrics** | Prometheus | Time-series metrics |
| **Visualization** | Grafana | Dashboards |
| **Tracing** | OpenTelemetry | Distributed tracing |
| **Logging** | Pino + Grafana Loki | Structured logging |
| **Alerting** | Grafana Alerting | Notifications |

## ✅ DO

### Application Metrics

**✅ DO**: Instrument key application metrics

```typescript
// packages/observability/lib/metrics.ts
import { Counter, Histogram, Gauge, Registry } from "prom-client";

export const registry = new Registry();

// Request metrics
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

// Business metrics
export const workflowExecutions = new Counter({
  name: "workflow_executions_total",
  help: "Total workflow executions",
  labelNames: ["status", "trigger_type"],
  registers: [registry],
});

export const aiTokensUsed = new Counter({
  name: "ai_tokens_total",
  help: "Total AI tokens used",
  labelNames: ["model", "type", "feature"],
  registers: [registry],
});

export const activeConnections = new Gauge({
  name: "active_connections",
  help: "Current active connections",
  labelNames: ["type"],
  registers: [registry],
});
```

**✅ DO**: Use middleware for automatic instrumentation

```typescript
// packages/api/orpc/middleware/metrics.ts
import { httpRequestDuration, httpRequestTotal } from "@repo/observability";

export async function metricsMiddleware(
  c: Context,
  next: Next,
): Promise<Response> {
  const start = Date.now();
  const method = c.req.method;
  const route = c.req.routePath;

  try {
    await next();
  } finally {
    const duration = (Date.now() - start) / 1000;
    const status = c.res.status.toString();

    httpRequestDuration.observe({ method, route, status }, duration);
    httpRequestTotal.inc({ method, route, status });
  }
}
```

### Structured Logging

**✅ DO**: Use structured, contextual logging

```typescript
// packages/logs/lib/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({}),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: "fabric-portal",
    environment: process.env.NODE_ENV,
  },
});

// Create child loggers with context
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({
    requestId,
    userId,
  });
}

// Usage in procedures
export const getWorkflowProcedure = protectedProcedure
  .handler(async ({ input, context }) => {
    const log = createRequestLogger(context.requestId, context.user.id);
    
    log.info({ workflowId: input.id }, "Fetching workflow");
    
    const workflow = await getWorkflowById(input.id);
    
    if (!workflow) {
      log.warn({ workflowId: input.id }, "Workflow not found");
      throw new ORPCError("NOT_FOUND");
    }
    
    log.info({ workflowId: input.id }, "Workflow fetched successfully");
    
    return { workflow };
  });
```

### Distributed Tracing

**✅ DO**: Implement OpenTelemetry tracing

```typescript
// packages/observability/lib/tracing.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({
  serviceName: "fabric-portal",
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

// Manual span creation
import { trace, SpanKind } from "@opentelemetry/api";

const tracer = trace.getTracer("fabric-portal");

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// Usage
const result = await withSpan(
  "processDocument",
  { documentId, userId },
  () => processDocument(documentId),
);
```

### Health and Readiness Probes

**✅ DO**: Implement separate health and readiness endpoints

```typescript
// packages/api/index.ts

// Liveness probe - is the service running?
app.get("/health/live", (c) => {
  return c.json({ status: "alive" });
});

// Readiness probe - can the service handle traffic?
app.get("/health/ready", async (c) => {
  const checks = await Promise.allSettled([
    db.$queryRaw`SELECT 1`,
    qdrantClient.getCollections(),
  ]);

  const allReady = checks.every((r) => r.status === "fulfilled");

  return c.json(
    { status: allReady ? "ready" : "not_ready" },
    allReady ? 200 : 503,
  );
});

// Detailed health check
app.get("/health/detailed", async (c) => {
  const startTime = Date.now();
  
  const checks = {
    database: await checkDatabase(),
    temporal: await checkTemporal(),
    qdrant: await checkQdrant(),
    redis: await checkRedis(),
  };

  return c.json({
    status: Object.values(checks).every((c) => c.healthy) ? "healthy" : "degraded",
    uptime: process.uptime(),
    responseTime: Date.now() - startTime,
    checks,
  });
});
```

### Dashboard Design

**✅ DO**: Create focused, actionable dashboards

```yaml
# monitoring/grafana/dashboards/overview.json
# Key metrics for the overview dashboard:

# RED Metrics (Request, Error, Duration)
- Rate: requests per second
- Errors: error rate percentage  
- Duration: p50, p95, p99 latencies

# USE Metrics (Utilization, Saturation, Errors)
- CPU utilization
- Memory usage
- Connection pool saturation
- Database connection errors

# Business Metrics
- Active users
- Workflow executions
- AI tokens consumed
- Document processing queue depth
```

## ❌ DON'T

### Log Sensitive Data

**❌ DON'T**: Log passwords, tokens, or PII

```typescript
// Bad: Logging sensitive data
logger.info({ user: user, password: password }, "Login attempt");
logger.debug({ apiKey: apiKey }, "API call");
logger.info({ email: user.email, ssn: user.ssn }, "User data");
```
**Why**: Security and privacy violations.

**✅ Better**:

```typescript
// Good: Redact sensitive fields
logger.info({ userId: user.id, email: "[REDACTED]" }, "Login attempt");
logger.debug({ apiKeyPrefix: apiKey.slice(0, 8) }, "API call");
```

### Alert on Everything

**❌ DON'T**: Create alerts that cause alert fatigue

```yaml
# Bad: Too many alerts
- alert: HighCPU
  expr: cpu_usage > 50%  # Too sensitive
  
- alert: AnyError
  expr: error_count > 0  # Fires constantly
  
- alert: SlowRequest
  expr: request_duration > 100ms  # Normal variance
```
**Why**: Team ignores alerts, misses real issues.

**✅ Better**:

```yaml
# Good: Alert on user-impacting symptoms
- alert: HighErrorRate
  expr: rate(http_errors_total[5m]) / rate(http_requests_total[5m]) > 0.01
  for: 5m
  labels:
    severity: critical
    
- alert: SlowP99Latency
  expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 2
  for: 10m
  labels:
    severity: warning
```

### Unbounded Cardinality

**❌ DON'T**: Create metrics with high cardinality

```typescript
// Bad: User ID as label creates unbounded cardinality
httpRequestDuration.observe({ userId: user.id, route, method }, duration);

// Bad: Full URL path with dynamic segments
httpRequestDuration.observe({ path: `/users/${userId}/posts/${postId}` }, duration);
```
**Why**: Crashes Prometheus, expensive storage.

**✅ Better**:

```typescript
// Good: Use route templates, not actual paths
httpRequestDuration.observe({ route: "/users/:id/posts/:postId" }, duration);

// Track user-specific metrics separately if needed
userSpecificGauge.set({ userId }, value);  // Only if cardinality is bounded
```

## Patterns & Examples

### Pattern 1: Request Context Propagation

**Use Case**: Trace requests across services

```typescript
// Middleware to extract/generate trace context
import { context, propagation, trace } from "@opentelemetry/api";

export async function tracingMiddleware(c: Context, next: Next) {
  // Extract trace context from incoming request
  const parentContext = propagation.extract(context.active(), c.req.header);
  
  // Generate request ID
  const requestId = c.req.header("x-request-id") || crypto.randomUUID();
  
  // Create span and propagate context
  return context.with(parentContext, async () => {
    const span = trace.getTracer("api").startSpan("http-request", {
      attributes: {
        "http.method": c.req.method,
        "http.route": c.req.routePath,
        "request.id": requestId,
      },
    });

    c.set("requestId", requestId);
    c.set("span", span);

    try {
      await next();
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### Pattern 2: SLO-Based Alerting

**Use Case**: Alert based on service level objectives

```yaml
# Alert when error budget is being consumed too fast
- alert: ErrorBudgetBurn
  expr: |
    (
      sum(rate(http_requests_total{status=~"5.."}[1h]))
      /
      sum(rate(http_requests_total[1h]))
    ) > 14.4 * 0.001  # 14.4x burn rate on 0.1% error budget
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Error budget being consumed too fast"
    description: "At current rate, monthly error budget will be exhausted in {{ $value | humanizeDuration }}"
```

### Pattern 3: Custom Business Metrics

**Use Case**: Track business-specific KPIs

```typescript
// Business metrics for workflow feature
const workflowMetrics = {
  created: new Counter({
    name: "workflows_created_total",
    help: "Total workflows created",
    labelNames: ["trigger_type", "is_template"],
  }),
  
  executionDuration: new Histogram({
    name: "workflow_execution_duration_seconds",
    help: "Workflow execution duration",
    labelNames: ["workflow_id", "status"],
    buckets: [1, 5, 30, 60, 300, 600, 1800],
  }),
  
  nodeExecutions: new Counter({
    name: "workflow_node_executions_total",
    help: "Total workflow node executions",
    labelNames: ["node_type", "status"],
  }),
  
  aiCosts: new Counter({
    name: "workflow_ai_costs_dollars",
    help: "AI costs in dollars",
    labelNames: ["model", "workflow_id"],
  }),
};

// Record metrics in workflow execution
export async function recordWorkflowExecution(execution: WorkflowExecution) {
  const duration = (execution.completedAt - execution.startedAt) / 1000;
  
  workflowMetrics.executionDuration.observe(
    { workflow_id: execution.workflowId, status: execution.status },
    duration,
  );
  
  for (const node of execution.nodeResults) {
    workflowMetrics.nodeExecutions.inc({
      node_type: node.type,
      status: node.status,
    });
    
    if (node.aiCost) {
      workflowMetrics.aiCosts.inc(
        { model: node.model, workflow_id: execution.workflowId },
        node.aiCost,
      );
    }
  }
}
```

## Grafana Dashboard Examples

```json
// Key panels for API dashboard
{
  "panels": [
    {
      "title": "Request Rate",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total[5m])) by (route)"
        }
      ]
    },
    {
      "title": "Error Rate",
      "type": "gauge",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) * 100"
        }
      ],
      "thresholds": [
        { "value": 0, "color": "green" },
        { "value": 1, "color": "yellow" },
        { "value": 5, "color": "red" }
      ]
    },
    {
      "title": "Latency (p95)",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))"
        }
      ]
    }
  ]
}
```

## Common Mistakes

1. **No baseline metrics**
   - Problem: Can't detect anomalies
   - Solution: Collect metrics before issues occur

2. **Missing request IDs**
   - Problem: Can't correlate logs across services
   - Solution: Generate and propagate request IDs

3. **Logging only errors**
   - Problem: No context when debugging
   - Solution: Log key events at INFO level

4. **No metric retention policy**
   - Problem: Storage costs explode
   - Solution: Define retention based on value

## Resources

- [Prometheus Best Practices](https://prometheus.io/docs/practices/)
- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Google SRE Book](https://sre.google/sre-book/table-of-contents/)
- [Grafana Dashboards](https://grafana.com/grafana/dashboards/)


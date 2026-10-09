# @repo/observability

Centralized observability package for Fabric applications providing OpenTelemetry-based traces, metrics, and logs.

## Quick Start

### 1. Initialize Observability

Call `initObservability()` once at application startup:

```typescript
// In Next.js: apps/web/instrumentation.ts
import { initObservability } from '@repo/observability';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    initObservability({
      serviceName: 'fabric-web',
      serviceVersion: '1.0.0',
    });
  }
}

// In a Node.js service:
import { initObservability } from '@repo/observability';

initObservability({
  serviceName: 'my-service',
});
```

### 2. Environment Variables

```bash
# Enable observability (auto-enables if endpoint is set)
OTEL_ENABLED=true

# OTLP endpoint (Jaeger, Aspire Dashboard, etc.)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Service name (optional, can be set in code)
OTEL_SERVICE_NAME=my-service
```

## Instrumentation Modules

### LLM Instrumentation

Track AI/LLM calls with automatic metrics:

```typescript
import { llmInstrumentation } from '@repo/observability';

// Trace an LLM call
const response = await llmInstrumentation.trace('chat-completion', {
  provider: 'anthropic',
  model: 'claude-3-sonnet',
  temperature: 0.7,
}, async (span) => {
  const result = await anthropic.messages.create({
    model: 'claude-3-sonnet-20240229',
    messages: [{ role: 'user', content: 'Hello!' }],
  });

  // Record token usage
  span.setTokenUsage(result.usage.input_tokens, result.usage.output_tokens);
  span.setFinishReason(result.stop_reason);

  return result;
});

// Track streaming responses
llmInstrumentation.recordStreamingResponse({
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 100,
  outputTokens: 500,
  durationMs: 2500,
});

// Trace tool/function calls
await llmInstrumentation.traceToolCall('web-search', async (span) => {
  return await searchWeb(query);
});
```

**Metrics recorded:**
- `llm.requests` - Counter of LLM requests by provider/model/status
- `llm.tokens` - Counter of tokens by type (input/output)
- `llm.request.duration` - Histogram of request duration
- `llm.errors` - Counter of errors by type

#### Decision calls (`experimental_decide`)

AI decision calls are traced and measured without recording content. Neither
the AI SDK's own telemetry option nor `@ai-sdk/otel` is used, because
registering it would capture prompts and outputs for every AI call.

- `llm.decide` span - one per decision-model round trip, opened by
  `wrapDecisionModelWithTelemetry` (`packages/ai/lib/decision-telemetry.ts`)
  through `llmInstrumentation.startInvocation({ operation: "decide" })`.
  Attributes: `gen_ai.system`, `gen_ai.request.model` (requested),
  `gen_ai.response.model` (answering model: the requested model or a known
  gateway fallback, otherwise `unknown`), `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `llm.outcome`, `error.type` on failure, `llm.decision.question_count`,
  `llm.decision.refusal_count` (a number, never the refusal), and the
  span-only identifiers `fabric.organization.id`, `fabric.project.id`,
  `fabric.feature_key`, `fabric.job_type` (each omitted when absent).
- The same invocation feeds `llm.requests`, `llm.request.duration` and
  `llm.errors` with `operation: "decide"`. `llm.tokens` has no `operation`
  label (provider, model and type only), so decide tokens are told apart from
  chat tokens by nothing but the model.
- `llm.decision.outcomes` - Counter by `site`, `outcome`, `model`. Recorded
  by each decision call site through `recordDecisionOutcome` once it knows
  whether it used the answer. `outcome` is one of `accepted`,
  `below_threshold`, `malformed`, `refused`, `failed`, `limit_exceeded`,
  `unavailable`; everything except `accepted` and `limit_exceeded` means the
  site fell back to the language model. `malformed` covers an answer the AI
  SDK rejects as invalid (`InvalidResponseDataError`) and a readable answer
  the site cannot use; `refused` is `Experimental_DecisionRefusalError`;
  transport, HTTP, abort and timeout errors are `failed`. `model` is the
  catalog name of the model that answered, even when the SDK then threw (a
  request-scoped capture records it); it is the requested model, a known
  gateway fallback, or `unknown`, and a model id supplied by the provider is
  never used as a label (`none` when no decision model resolved). `site` is
  one of five fixed names.
- `llm.decision.confidence` - Histogram (0..1) by `site`, `model`: one sample
  per readable answer (the chosen option's probability, or the likelier side
  of a boolean).
- The same call also sets `llm.decision.site`, `llm.decision.outcome` and
  `llm.decision.confidence` (lowest sample) on the active span, if there is one.

Privacy: only identifiers, model ids, counts, numbers, enums and error class
names are recorded. Prompts, decision state, questions, instructions,
criteria, chosen labels, answer text, reasoning and error messages never reach
a span attribute, span event or metric label, and `organizationId` is never
a metric label. `packages/temporal/__tests__/decision-telemetry-privacy.test.ts`
checks this with a planted sentinel.

### Database Instrumentation

Track Prisma database operations:

```typescript
import { databaseInstrumentation } from '@repo/observability';

// Manual tracing
const users = await databaseInstrumentation.trace({
  operation: 'findMany',
  model: 'User',
}, async (span) => {
  return await prisma.user.findMany({ where: { active: true } });
});

// Prisma middleware (add to client setup)
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
prisma.$use(databaseInstrumentation.createPrismaMiddleware());
```

**Metrics recorded:**
- `db.queries` - Counter of queries by operation/model/status
- `db.query.duration` - Histogram of query duration
- `db.errors` - Counter of errors
- `db.slow_queries` - Counter of slow queries (>1000ms)

### RAG Instrumentation

Track vector search and embedding operations:

```typescript
import { ragInstrumentation } from '@repo/observability';

// Trace vector search
const results = await ragInstrumentation.traceVectorSearch({
  collection: 'documents',
  topK: 10,
}, async (span) => {
  const searchResults = await qdrant.search('documents', {
    vector: queryEmbedding,
    limit: 10,
  });

  span.setResultCount(searchResults.length);
  span.setScoreRange(
    Math.min(...searchResults.map(r => r.score)),
    Math.max(...searchResults.map(r => r.score))
  );

  return searchResults;
});

// Trace embedding generation
const embeddings = await ragInstrumentation.traceEmbedding({
  model: 'text-embedding-3-small',
  batchSize: 10,
  provider: 'openai',
}, async (span) => {
  return await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
});

// Record embedding token usage
ragInstrumentation.recordEmbeddingTokens(1500, 'text-embedding-3-small', 'openai');
```

**Metrics recorded:**
- `rag.vector_search` - Counter of searches
- `rag.vector_search.duration` - Histogram of search duration
- `rag.vector_search.results` - Histogram of result counts
- `rag.embeddings` - Counter of embedding operations
- `rag.embedding.duration` - Histogram of embedding duration
- `rag.embedding.tokens` - Counter of embedding tokens

### HTTP Instrumentation

Track HTTP requests (in addition to auto-instrumentation):

```typescript
import { httpInstrumentation } from '@repo/observability';

// Trace an outgoing API call
const data = await httpInstrumentation.traceApiCall({
  method: 'POST',
  path: '/api/external/service',
  service: 'external-api',
}, async (span) => {
  const response = await fetch('https://api.example.com/data', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  span.setStatusCode(response.status);
  return response.json();
});

// Express/Next.js middleware
app.use(httpInstrumentation.createMiddleware());

// Record server request manually
httpInstrumentation.recordServerRequest({
  method: 'POST',
  route: '/api/chat',
  statusCode: 200,
  durationMs: 150,
});
```

## Custom Spans and Metrics

For operations not covered by built-in instrumentation:

```typescript
import { getTracer, getMeter, getLogger } from '@repo/observability';

// Create custom spans
const tracer = getTracer('my-module');
await tracer.startActiveSpan('custom-operation', async (span) => {
  span.setAttribute('custom.attribute', 'value');
  // ... your code
  span.end();
});

// Create custom metrics
const meter = getMeter('my-module');
const counter = meter.createCounter('my_custom_counter');
counter.add(1, { label: 'value' });

// Create custom logs
const logger = getLogger('my-module');
logger.emit({
  severityNumber: SeverityNumber.INFO,
  body: 'Custom log message',
});
```

## Console Log Forwarding

All `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` calls are automatically forwarded to the OTLP endpoint when observability is initialized. This means:

1. Logs appear in your terminal (stdout/stderr)
2. Logs appear in the Aspire Dashboard "Console logs" section
3. Logs appear in Azure Log Analytics (when deployed)

## Direct Log Forwarding (`initAppInsightsLogs`)

The section above assumes a process running the full OTel pipeline (a
collector reachable via `OTEL_EXPORTER_OTLP_ENDPOINT`). A service that only
holds a direct App Insights connection string — Vercel deployments cannot
run a collector sidecar — needs a separate, minimal path from its
`@repo/logs` calls straight to App Insights, independent of the
`feature-burn-rate-alerts` kill switch that gates `trackEvent`/`trackMetric`
above.

```typescript
// Once at process boot (e.g. apps/web/instrumentation.ts):
import { initAppInsightsLogs, trackLog, trackLogException } from '@repo/observability';
import { addLogSink } from '@repo/logs';

initAppInsightsLogs({ cloudRoleName: 'fabric.web' });
addLogSink((record) => {
  if (record.error) {
    trackLogException(record.error, record.properties);
  } else {
    trackLog(record.level, record.message, record.properties);
  }
});
```

- `@repo/logs` never imports this package — `addLogSink` is a generic hook
  (consola `addReporter` under the hood); the caller wires the two together,
  so `@repo/logs` stays free of the `applicationinsights` dependency and its
  transitive graph, and free of the cycle that importing `@repo/database`'s
  `redactSensitiveKeys` from inside `@repo/logs` would create.
- Every record `addLogSink` hands to a sink has already been through the
  shared sensitive-key + value-shape redactor
  (`@repo/utils/log-redaction`) — message and structured properties alike.
- `trackLog`/`trackLogException` map warn/error/fatal to App Insights'
  Warning/Error/Critical severities via `trackTrace`/`trackException`, and
  sample per key per process instance (20/min by default, keyed on
  `properties.event` when present) so a hot-path failure cannot flood one
  worker — a single
  "suppressed N similar records" trace marks each window that dropped any.
- The web API deliberately emits one `HttpRequest` custom metric for each
  oRPC procedure call and one `AppError` metric for each procedure failure.
  At `R` average procedure calls per second and `F` failures per call, that is
  `60 × R × (1 + F)` metric points per minute: 100 calls/second with 1% errors
  emits about 6,060 points/minute; an all-failing 100 calls/second workload is
  bounded at 12,000. They are metrics, not custom events. The SEV-1
  integration-event query excludes `fabric.web` explicitly as well as filtering
  on the named circuit breaker event, so future web custom events cannot page
  that rule.
- Dashboard owners: `fabric.web` is the web direct-client role. Other direct
  clients may use a different role than the collector's `fabric.<app>` naming
  convention, so a query that spans services must use each application's
  configured `cloud_RoleName` rather than assuming the web role.
- A process that only ever calls `initAppInsightsLogs()` (never
  `initAppInsights()`) still gets a real, shared direct client — the two
  entry points are independent, and calling both is safe.
- On a platform that freezes the process between requests (Vercel Fluid
  Compute), call `flushAppInsights()` — e.g. via Next's `after()` on every
  request — so batched telemetry is not stranded unflushed when the process
  is frozen before its own batching interval fires. `flushAppInsights()` skips
  the outbound SDK flush when this process has not queued direct telemetry.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Application                                                │
│  ┌─────────────────────────────────────────────────────────┤
│  │  initObservability()                                    │
│  │  ├── Traces → OTLP Exporter → Aspire/Jaeger            │
│  │  ├── Metrics → OTLP Exporter → Aspire/Prometheus       │
│  │  └── Logs → OTLP Exporter → Aspire Dashboard           │
│  ├─────────────────────────────────────────────────────────┤
│  │  Instrumentation Modules                                │
│  │  ├── llmInstrumentation (AI calls)                     │
│  │  ├── databaseInstrumentation (Prisma)                  │
│  │  ├── ragInstrumentation (Vector search)                │
│  │  └── httpInstrumentation (API calls)                   │
└──┴─────────────────────────────────────────────────────────┘
```

## Viewing Telemetry

### Local Development (Aspire Dashboard)

1. Start the Aspire AppHost: `cd aspire/Fabric.AppHost && dotnet run`
2. Open the Aspire Dashboard URL shown in the terminal
3. View:
   - **Traces** - Distributed traces across services
   - **Metrics** - Performance metrics and counters
   - **Console Logs** - Structured logs from all services

### Azure Container Apps (Production)

- Aspire Dashboard: `https://aspire-dashboard.ext.<env>.azurecontainerapps.io/`
- Azure Log Analytics: Query with KQL in Azure Portal

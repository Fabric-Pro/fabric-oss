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

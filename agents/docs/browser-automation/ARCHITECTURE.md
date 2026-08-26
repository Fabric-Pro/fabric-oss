# Browser Automation Architecture

> **Version**: 1.1
> **Date**: December 16, 2024
> **Status**: Phase 1 Complete ✅

## Overview

Browser automation enables AI agents to interact with web interfaces that lack APIs. This is a key capability inspired by CUGA (ConfigUrable Generalist Agent) research, adapted for fabric-portal's multi-tenant architecture.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Browser Automation Architecture                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐        │
│  │   Workflow      │     │   LangGraph     │     │   RAG Pipeline  │        │
│  │   Builder       │     │   Agents        │     │   (Browser      │        │
│  │   (browser-*    │     │   (CopilotKit)  │     │   RAGProvider)  │        │
│  │   step nodes)   │     │                 │     │                 │        │
│  └───────┬─────────┘     └───────┬─────────┘     └───────┬─────────┘        │
│          │                       │                       │                   │
│          └───────────────┬───────┴───────────────────────┘                   │
│                          ▼                                                   │
│         ┌────────────────────────────────────────┐                          │
│         │        Temporal Workflows              │                          │
│         │  ┌──────────────────────────────────┐  │                          │
│         │  │  browserAutomationWorkflow       │  │                          │
│         │  │  - Session management            │  │                          │
│         │  │  - Action orchestration          │  │                          │
│         │  │  - Multi-tenant isolation        │  │                          │
│         │  └──────────────────────────────────┘  │                          │
│         └────────────────┬───────────────────────┘                          │
│                          ▼                                                   │
│         ┌────────────────────────────────────────┐                          │
│         │        Temporal Activities             │                          │
│         │  ┌──────────────────────────────────┐  │                          │
│         │  │ Browser Activities:              │  │                          │
│         │  │ - createBrowserSession           │  │                          │
│         │  │ - navigate                       │  │                          │
│         │  │ - click / type / select          │  │                          │
│         │  │ - extractContent                 │  │                          │
│         │  │ - screenshot                     │  │                          │
│         │  │ - authenticate                   │  │                          │
│         │  │ - closeBrowserSession            │  │                          │
│         │  └──────────────────────────────────┘  │                          │
│         └────────────────┬───────────────────────┘                          │
│                          ▼                                                   │
│         ┌────────────────────────────────────────┐                          │
│         │        Playwright Runtime              │                          │
│         │  ┌──────────────────────────────────┐  │                          │
│         │  │ BrowserSessionManager:           │  │                          │
│         │  │ - Per-tenant browser contexts    │  │                          │
│         │  │ - Session pooling                │  │                          │
│         │  │ - Cookie/storage isolation       │  │                          │
│         │  │ - Automatic cleanup              │  │                          │
│         │  └──────────────────────────────────┘  │                          │
│         └────────────────────────────────────────┘                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Multi-Tenant Session Isolation

Each browser session is isolated by `userId` + `organizationId`:

```typescript
interface BrowserSessionContext {
  sessionId: string;
  userId: string;
  organizationId?: string;
  // Isolated storage
  storageState?: {
    cookies: Cookie[];
    localStorage: Record<string, string>;
  };
}
```

### 2. Temporal Workflow Integration

Browser automation runs as Temporal activities for:
- **Durability**: Automatic retries on failures
- **Visibility**: Track execution state and history
- **Timeouts**: Configurable per-action timeouts
- **Isolation**: Activities run in separate processes

### 3. Session Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Create     │────▶│   Execute    │────▶│   Extract    │────▶│   Close      │
│   Session    │     │   Actions    │     │   Results    │     │   Session    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
      │                    │                    │                    │
      ▼                    ▼                    ▼                    ▼
 BrowserTask:         Action logs          Output data         Cleanup storage
 PENDING → RUNNING   in AgentTask.state    in result field     (optional persist)
```

### 4. Security Considerations

- **Credential Storage**: OAuth tokens stored encrypted in MCPConfig table
- **URL Allowlist**: Optional URL pattern restrictions per organization
- **Session Timeout**: Maximum session duration (default: 5 minutes)
- **Screenshot Redaction**: Automatic PII detection (optional)

## Components

### 1. Database Schema (`BrowserTask`)

Tracks browser automation tasks with multi-tenancy:

```prisma
model BrowserTask {
  id              String        @id @default(cuid())
  userId          String
  organizationId  String?
  status          BrowserTaskStatus @default(PENDING)
  sessionId       String?       // Playwright session ID
  actions         Json          // Array of BrowserAction[]
  result          Json?         // Extraction results
  screenshots     String[]      // S3 URLs for screenshots
  error           String?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  completedAt     DateTime?
  
  user            User          @relation(...)
  organization    Organization? @relation(...)
}
```

### 2. Browser Activities (`packages/temporal/src/activities/browser-activities.ts`)

Temporal activities for browser operations:

| Activity | Purpose | Timeout |
|----------|---------|---------|
| `createBrowserSession` | Initialize isolated browser context | 30s |
| `navigateToUrl` | Navigate to URL with wait conditions | 60s |
| `executeAction` | Execute single browser action | 30s |
| `extractContent` | Extract content using selectors | 30s |
| `takeScreenshot` | Capture screenshot, upload to S3 | 30s |
| `authenticateWithCredentials` | Handle OAuth/login flows | 60s |
| `closeBrowserSession` | Cleanup browser context | 10s |

### 3. Browser Workflow (`packages/temporal/src/workflows/browser-automation.ts`)

Orchestrates browser automation with retry logic:

```typescript
export interface BrowserAutomationInput {
  taskId: string;
  userId: string;
  organizationId?: string;
  url: string;
  actions: BrowserAction[];
  extractors?: ContentExtractor[];
  auth?: BrowserAuthConfig;
  options?: BrowserSessionOptions;
}
```

### 4. Workflow Builder Step (`browser-action` step type)

Integrates with AI Workflow Builder for hybrid workflows.

## Integration Points

### With RAG Pipeline

```typescript
// BrowserRAGProvider extracts web content for RAG
class BrowserRAGProvider implements IDocumentExtractor {
  async extract(source: BrowserSource): Promise<ExtractionResult> {
    // 1. Start browser automation workflow
    // 2. Navigate and extract content
    // 3. Return as RAG documents
  }
}
```

### With LangGraph Agents

```typescript
// Browser tool for LangGraph agents
const browserTool = createBrowserTool({
  name: 'browser_navigate',
  description: 'Navigate to URL and extract content',
  schema: z.object({
    url: z.string().url(),
    extractors: z.array(ContentExtractorSchema).optional(),
  }),
});
```

### With Workflow Builder

New step types registered in `step-registry.ts`:
- `browser-navigate`: Navigate to URL and optionally extract content
- `browser-extract`: Extract content from page using CSS selectors
- `browser-action`: Execute sequence of actions (click, type, select, scroll)
- `browser-screenshot`: Capture screenshot and upload to S3

## Implementation Status

### Phase 1: Browser Agent Core ✅

| Component | File | Status |
|-----------|------|--------|
| Prisma Schema | `packages/database/prisma/schema.prisma` | ✅ Complete |
| Types | `packages/temporal/src/activities/browser-automation/types.ts` | ✅ Complete |
| Session Manager | `packages/temporal/src/activities/browser-automation/session-manager.ts` | ✅ Complete |
| Activities | `packages/temporal/src/activities/browser-automation/activities.ts` | ✅ Complete |
| Workflow | `packages/temporal/src/workflows/browser-automation.ts` | ✅ Complete |
| Step: Navigate | `packages/temporal/src/activities/lib/steps/browser-navigate.ts` | ✅ Complete |
| Step: Extract | `packages/temporal/src/activities/lib/steps/browser-extract.ts` | ✅ Complete |
| Step: Screenshot | `packages/temporal/src/activities/lib/steps/browser-screenshot.ts` | ✅ Complete |
| Step: Action | `packages/temporal/src/activities/lib/steps/browser-action.ts` | ✅ Complete |

### Phase 2: RAG Enhancement ✅

| Component | Location | Status |
|-----------|----------|--------|
| BrowserExtractor | `packages/rag/lib/extraction/extractors/browser-extractor.ts` | ✅ Complete |
| BrowserExtractorClient | `packages/rag/lib/extraction/extractors/browser-extractor-client.ts` | ✅ Complete |
| Browser RAG Ingestion Workflow | `packages/temporal/src/workflows/browser-rag-ingestion.ts` | ✅ Complete |
| chunkAndStoreWebContent Activity | `packages/temporal/src/activities/document-processing.ts` | ✅ Complete |

### Phase 3: Hybrid Execution Mode ✅

| Component | Location | Status |
|-----------|----------|--------|
| Hybrid Step | `packages/temporal/src/activities/lib/steps/hybrid-step.ts` | ✅ Complete |
| Hybrid Execution Workflow | `packages/temporal/src/workflows/hybrid-execution.ts` | ✅ Complete |
| Step Registry Entry | `hybrid-step` in step-registry.ts | ✅ Complete |

**Supported Modes:**
- `api-first`: Try API call first, fallback to browser on error
- `browser-first`: Try browser first, fallback to API on error
- `api-only`: API call only, no fallback
- `browser-only`: Browser automation only, no fallback
- `parallel`: Execute both simultaneously, return first success

### Phase 4: Save & Reuse Templates ✅

| Component | Location | Status |
|-----------|----------|--------|
| Template Types | `packages/temporal/src/activities/automation-template/types.ts` | ✅ Complete |
| Template Activities | `packages/temporal/src/activities/automation-template/activities.ts` | ✅ Complete |
| Template Execution Workflow | `packages/temporal/src/workflows/template-execution.ts` | ✅ Complete |
| AutomationTemplate Model | `packages/database/prisma/schema.prisma` | ✅ Complete |

**Features:**
- Create templates from successful browser tasks
- Parameterize templates with `{{paramName}}` placeholders
- Share templates within organizations (isPublic flag)
- Version tracking and usage analytics
- Category and tag-based organization


# Reporting System Architecture v2

## Executive Summary

This document outlines a comprehensive re-architecture of the Fabric Reporting System to support:
1. **Explicit connection types** - Templates clearly specify whether they need MCP servers or Workflow Integrations
2. **RAG-based data processing** - Large datasets are stored in Qdrant and retrieved via semantic search
3. **Incremental data updates** - Support for scheduled reports with delta fetching
4. **Orchestrator integration** - Leverage the existing orchestrator for complex multi-step reports

---

## Current Problems

### 1. Ambiguous Connection Types
- Templates define `mcpServers` as required data sources
- But the runtime tries to "discover" whether to use MCP or Workflow Integration
- This causes confusion when user has both configured for the same service

### 2. Data Volume Issues
- Current implementation sends all fetched data directly to the AI model
- For reports like "analyze Slack for the past month", this could be 10,000+ messages
- No chunking or RAG-based retrieval

### 3. No Incremental Updates
- Every report run fetches all data fresh
- Scheduled reports re-fetch the same historical data repeatedly
- No concept of "last run" or delta fetching

### 4. Credential Discovery Failures
- `fetchCredentialsByProvider` expects specific key formats (`SLACK_API_KEY`)
- Mismatch between how credentials are stored vs how they're looked up

---

## Proposed Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         REPORT GENERATION FLOW                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Template Definition                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  dataSources:                                                        │   │
│  │    - type: "mcp" | "integration" | "workspace" | "user-input"       │   │
│  │      provider: "slack" | "github" | "linear" | etc.                 │   │
│  │      operation: "get_channel_history" | "list_issues" | etc.        │   │
│  │      config: { ... }                                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
│                                      ▼                                       │
│  Instance Creation (User binds credentials)                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  connections:                                                        │   │
│  │    mcpBindings: { "slack": "mcp-config-id-123" }                    │   │
│  │    integrationBindings: { "github": "integration-id-456" }          │   │
│  │    resourceBindings: { "slack": { resourceId: "C123", ... } }       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
│                                      ▼                                       │
│  Execution Workflow                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │  Phase 1: Data Collection                                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ MCP Handler  │  │ Integration  │  │  Workspace   │              │   │
│  │  │              │  │   Handler    │  │   Handler    │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  │         │                 │                 │                       │   │
│  │         └─────────────────┴─────────────────┘                       │   │
│  │                           │                                          │   │
│  │                           ▼                                          │   │
│  │  Phase 2: Data Processing & Indexing                                │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  Raw Data → Chunking → Embedding → Qdrant Storage            │  │   │
│  │  │  (Ephemeral collection: report_exec_{executionId})           │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  │                           │                                          │   │
│  │                           ▼                                          │   │
│  │  Phase 3: AI Analysis (RAG-enhanced)                                │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  For each AI task:                                            │  │   │
│  │  │    1. Generate query embedding                                │  │   │
│  │  │    2. Retrieve relevant chunks from Qdrant                    │  │   │
│  │  │    3. Build context-aware prompt                              │  │   │
│  │  │    4. Generate analysis                                       │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  │                           │                                          │   │
│  │                           ▼                                          │   │
│  │  Phase 4: Report Rendering & Artifact Storage                       │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  Render markdown/HTML → Store artifact → Index for RAG       │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Schema Changes

### 1. Template Data Source Definition (Breaking Change)

```prisma
// New enum for explicit data source types
enum DataSourceType {
  MCP           // Requires MCP server config
  INTEGRATION   // Requires Workflow Integration
  WORKSPACE     // Requires workspace selection
  USER_INPUT    // User provides data at runtime
  FABRIC        // Internal Fabric patterns (YouTube, etc.)
}

// Updated template definition structure
// definition: {
//   dataSources: [
//     {
//       id: "slack-messages",
//       type: "INTEGRATION",        // <-- EXPLICIT TYPE
//       provider: "slack",          // Provider name (matches enum)
//       operation: "get_channel_history",
//       config: {
//         limit: 1000,
//         // For incremental: "since_last_run" or specific date range
//         fetchMode: "full" | "incremental" | "date_range"
//       },
//       // Data processing config
//       processing: {
//         chunkSize: 500,
//         chunkOverlap: 50,
//         embedForRag: true,
//         summarizeChunks: false,
//       }
//     }
//   ],
//   ...
// }
```

### 2. Instance Connections (Updated)

```prisma
// connections: {
//   // MCP bindings: dataSourceId -> mcpConfigId
//   mcpBindings: {
//     "github-issues": "mcp-config-123"
//   },
//   // Integration bindings: dataSourceId -> integrationId  
//   integrationBindings: {
//     "slack-messages": "integration-456"
//   },
//   // Resource selections (channels, boards, repos, etc.)
//   resourceBindings: {
//     "slack-messages": {
//       resourceId: "C01234567",
//       resourceName: "#engineering",
//       resourceType: "channel"
//     }
//   },
//   // Workspace bindings for RAG context
//   workspaceBindings: {
//     "context-docs": "workspace-789"
//   }
// }
```

### 3. Execution State (New Fields)

```prisma
model TemplateInstanceExecution {
  // ... existing fields ...
  
  // RAG collection for this execution
  qdrantCollectionId  String?
  
  // Incremental fetch state
  lastFetchTimestamps Json?    // { dataSourceId: timestamp }
  
  // Data statistics
  dataStats           Json?    // { dataSourceId: { recordCount, chunkCount, bytesProcessed } }
}
```

---

## Data Source Handlers

### Handler Interface

```typescript
interface DataSourceHandler {
  type: DataSourceType;
  supportedProviders: string[];
  
  // Validate that the user has configured this connection
  validateConnection(
    dataSource: DataSourceDefinition,
    connections: InstanceConnections,
    userId: string,
    organizationId?: string
  ): Promise<{ valid: boolean; error?: string }>;
  
  // Fetch data from the source
  fetchData(
    dataSource: DataSourceDefinition,
    connections: InstanceConnections,
    context: FetchContext
  ): Promise<FetchResult>;
  
  // Get incremental data since last fetch (optional)
  fetchIncremental?(
    dataSource: DataSourceDefinition,
    lastTimestamp: string,
    connections: InstanceConnections,
    context: FetchContext
  ): Promise<FetchResult>;
}

interface FetchContext {
  userId: string;
  organizationId?: string;
  parameters: Record<string, unknown>;
  dateRange?: { start: string; end: string };
  executionId: string;
}

interface FetchResult {
  success: boolean;
  data: unknown[];
  recordCount: number;
  hasMore: boolean;
  cursor?: string;
  metadata: {
    provider: string;
    operation: string;
    fetchedAt: string;
    // For incremental
    latestTimestamp?: string;
  };
  error?: string;
}
```

### MCP Handler

```typescript
class McpDataSourceHandler implements DataSourceHandler {
  type = DataSourceType.MCP;
  supportedProviders = ["github", "linear", "jira", "notion", "fizzy"];
  
  async validateConnection(dataSource, connections, userId, organizationId) {
    const mcpConfigId = connections.mcpBindings?.[dataSource.id];
    if (!mcpConfigId) {
      return { valid: false, error: `No MCP server configured for "${dataSource.id}"` };
    }
    
    // Verify MCP config exists and is healthy
    const config = await getMcpConfigById(mcpConfigId);
    if (!config || config.status !== "HEALTHY") {
      return { valid: false, error: `MCP server not available` };
    }
    
    return { valid: true };
  }
  
  async fetchData(dataSource, connections, context) {
    const mcpConfigId = connections.mcpBindings[dataSource.id];
    const resourceBinding = connections.resourceBindings?.[dataSource.id];
    
    // Build tool args
    const args = {
      ...dataSource.config.args,
      ...resourceBinding ? { [resourceBinding.resourceType]: resourceBinding.resourceId } : {},
      ...context.parameters,
    };
    
    // Use existing MCP tool execution
    const result = await executeMcpTool({
      toolName: dataSource.operation,
      args,
      userId: context.userId,
      organizationId: context.organizationId,
      mcpConfigId,
    });
    
    return {
      success: result.success,
      data: Array.isArray(result.output) ? result.output : [result.output],
      recordCount: Array.isArray(result.output) ? result.output.length : 1,
      hasMore: false,
      metadata: {
        provider: dataSource.provider,
        operation: dataSource.operation,
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}
```

### Integration Handler

```typescript
class IntegrationDataSourceHandler implements DataSourceHandler {
  type = DataSourceType.INTEGRATION;
  supportedProviders = ["slack", "github", "linear", "jira", "resend", "perplexity"];
  
  async validateConnection(dataSource, connections, userId, organizationId) {
    // Check for explicit integration binding first
    const integrationId = connections.integrationBindings?.[dataSource.id];
    
    if (integrationId) {
      const credentials = await fetchCredentialsById(integrationId, userId, organizationId);
      if (!credentials) {
        return { valid: false, error: `Integration ${integrationId} not found or inactive` };
      }
      return { valid: true };
    }
    
    // Fall back to provider lookup
    const providerName = dataSource.provider.toUpperCase() as WorkflowIntegrationProvider;
    const credentials = await fetchCredentialsByProvider(providerName, userId, organizationId);
    
    if (!credentials) {
      return { 
        valid: false, 
        error: `No ${dataSource.provider} integration configured. Please set up in Settings > Integrations.` 
      };
    }
    
    return { valid: true };
  }
  
  async fetchData(dataSource, connections, context) {
    const provider = dataSource.provider.toUpperCase() as WorkflowIntegrationProvider;
    const credentials = await fetchCredentialsByProvider(
      provider,
      context.userId,
      context.organizationId
    );
    
    if (!credentials) {
      throw new Error(`No ${provider} credentials found`);
    }
    
    // Route to provider-specific fetcher
    switch (provider) {
      case "SLACK":
        return this.fetchSlackData(credentials, dataSource, connections, context);
      case "GITHUB":
        return this.fetchGitHubData(credentials, dataSource, connections, context);
      case "LINEAR":
        return this.fetchLinearData(credentials, dataSource, connections, context);
      default:
        throw new Error(`Unsupported integration provider: ${provider}`);
    }
  }
  
  private async fetchSlackData(credentials, dataSource, connections, context) {
    const token = credentials.SLACK_API_KEY;
    const resourceBinding = connections.resourceBindings?.[dataSource.id];
    
    // Support pagination for large datasets
    const allMessages: unknown[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    const limit = dataSource.config.limit || 1000;
    
    while (hasMore && allMessages.length < limit) {
      const params = new URLSearchParams({
        channel: resourceBinding?.resourceId || context.parameters.channel as string,
        limit: String(Math.min(200, limit - allMessages.length)),
        ...(cursor ? { cursor } : {}),
        ...(context.dateRange?.start ? { oldest: this.dateToSlackTs(context.dateRange.start) } : {}),
        ...(context.dateRange?.end ? { latest: this.dateToSlackTs(context.dateRange.end) } : {}),
      });
      
      const response = await fetch(
        `https://slack.com/api/conversations.history?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      const data = await response.json();
      if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
      
      allMessages.push(...data.messages);
      cursor = data.response_metadata?.next_cursor;
      hasMore = !!cursor;
    }
    
    return {
      success: true,
      data: allMessages,
      recordCount: allMessages.length,
      hasMore: !!cursor,
      cursor,
      metadata: {
        provider: "slack",
        operation: dataSource.operation,
        fetchedAt: new Date().toISOString(),
        latestTimestamp: allMessages[0]?.ts,
      },
    };
  }
  
  private dateToSlackTs(date: string): string {
    return String(new Date(date).getTime() / 1000);
  }
}
```

---

## RAG-Based Data Processing

### Data Processing Pipeline

```typescript
interface DataProcessingConfig {
  chunkSize: number;      // Target chunk size in tokens
  chunkOverlap: number;   // Overlap between chunks
  embedForRag: boolean;   // Whether to embed chunks
  summarizeChunks: boolean; // Pre-summarize chunks before embedding
}

async function processDataForRag(
  executionId: string,
  dataSourceId: string,
  data: unknown[],
  config: DataProcessingConfig,
  userId: string,
  organizationId?: string
): Promise<ProcessingResult> {
  const collectionName = `report_exec_${executionId}`;
  
  // 1. Initialize ephemeral Qdrant collection
  await initializeReportCollection(collectionName);
  
  // 2. Convert data to text chunks
  const textChunks = await convertToTextChunks(data, config);
  
  // 3. Optionally summarize chunks first (for very large datasets)
  let processedChunks = textChunks;
  if (config.summarizeChunks && textChunks.length > 100) {
    processedChunks = await summarizeChunkBatches(textChunks);
  }
  
  // 4. Generate embeddings and store
  const embeddings = await generateBatchEmbeddings(
    processedChunks.map(c => c.content),
    { userId, organizationId }
  );
  
  // 5. Store in Qdrant
  await storeChunksInQdrant(collectionName, processedChunks, embeddings, {
    dataSourceId,
    executionId,
  });
  
  return {
    collectionName,
    chunkCount: processedChunks.length,
    bytesProcessed: textChunks.reduce((acc, c) => acc + c.content.length, 0),
  };
}

function convertToTextChunks(data: unknown[], config: DataProcessingConfig): TextChunk[] {
  const chunks: TextChunk[] = [];
  
  for (const item of data) {
    // Convert to text based on item structure
    const text = formatItemAsText(item);
    
    // Split into chunks with overlap
    const itemChunks = splitIntoChunks(text, config.chunkSize, config.chunkOverlap);
    
    chunks.push(...itemChunks.map((content, index) => ({
      content,
      metadata: {
        itemIndex: data.indexOf(item),
        chunkIndex: index,
        timestamp: (item as any).ts || (item as any).timestamp || (item as any).created_at,
      },
    })));
  }
  
  return chunks;
}

function formatItemAsText(item: unknown): string {
  if (typeof item === "string") return item;
  
  // Handle common data types
  if (isSlackMessage(item)) {
    return `[${new Date(parseFloat(item.ts) * 1000).toISOString()}] ${item.user}: ${item.text}`;
  }
  
  if (isGitHubIssue(item)) {
    return `Issue #${item.number}: ${item.title}\n${item.body || ""}\nState: ${item.state}, Labels: ${item.labels?.map(l => l.name).join(", ")}`;
  }
  
  if (isLinearIssue(item)) {
    return `${item.identifier}: ${item.title}\nState: ${item.state?.name}, Priority: ${item.priority}`;
  }
  
  // Fallback to JSON
  return JSON.stringify(item, null, 2);
}
```

### RAG-Enhanced AI Analysis

```typescript
async function executeRagEnhancedAnalysis(
  executionId: string,
  collectionName: string,
  aiTask: AiTask,
  context: AnalysisContext
): Promise<AiAnalysisResult> {
  // 1. Generate embedding for the task query
  const taskQuery = buildTaskQuery(aiTask);
  const queryEmbedding = await generateEmbedding(taskQuery, {
    userId: context.userId,
    organizationId: context.organizationId,
  });
  
  // 2. Retrieve relevant chunks
  const relevantChunks = await searchReportCollection(collectionName, {
    queryEmbedding: queryEmbedding.embedding,
    topK: 20,  // Get top 20 most relevant chunks
    minSimilarity: 0.5,
  });
  
  // 3. Build context-aware prompt
  const contextualPrompt = buildContextualPrompt(aiTask, relevantChunks, context);
  
  // 4. Execute AI analysis with Fabric AI enrichment
  const model = await getAiModel(context.userId, context.organizationId, false);
  
  const result = await generateText({
    model,
    system: context.enrichedSystemPrompt || aiTask.systemPrompt,
    prompt: contextualPrompt,
  });
  
  return {
    agentId: aiTask.agentId,
    task: aiTask.task,
    output: result.text,
    outputVariable: aiTask.outputVariable,
    chunksUsed: relevantChunks.length,
  };
}

function buildTaskQuery(aiTask: AiTask): string {
  // Extract key terms from the task for better retrieval
  return `${aiTask.task}

Key aspects to analyze:
- Main themes and patterns
- Notable items and outliers
- Trends over time
- Key participants or contributors`;
}

function buildContextualPrompt(
  aiTask: AiTask,
  chunks: RetrievedChunk[],
  context: AnalysisContext
): string {
  // Format chunks with relevance scores
  const formattedContext = chunks
    .map((chunk, i) => `[Chunk ${i + 1}] (relevance: ${(chunk.similarity * 100).toFixed(1)}%)\n${chunk.content}`)
    .join("\n\n---\n\n");
  
  return `## Your Task
${aiTask.task}

## Relevant Data Context
The following ${chunks.length} data excerpts are most relevant to your analysis task.
They are sorted by relevance to your task.

${formattedContext}

## Analysis Parameters
${context.parameters ? JSON.stringify(context.parameters, null, 2) : "None specified"}

## Instructions
- Base your analysis ONLY on the provided data context
- Cite specific data points when making claims
- Highlight trends, patterns, and anomalies
- Be concise but comprehensive
- Format using markdown for readability`;
}
```

---

## Incremental Data Fetching

### Fetch Modes

```typescript
enum FetchMode {
  FULL = "full",           // Fetch all data every time
  INCREMENTAL = "incremental", // Fetch only new data since last run
  DATE_RANGE = "date_range"    // Fetch data within specified date range
}

interface IncrementalFetchState {
  dataSourceId: string;
  lastFetchTimestamp: string;  // ISO timestamp
  lastCursor?: string;         // Pagination cursor if applicable
  lastRecordCount: number;
}
```

### Incremental Fetch Logic

```typescript
async function fetchDataWithMode(
  dataSource: DataSourceDefinition,
  handler: DataSourceHandler,
  connections: InstanceConnections,
  context: FetchContext,
  previousState?: IncrementalFetchState
): Promise<FetchResult> {
  const fetchMode = dataSource.config.fetchMode || FetchMode.FULL;
  
  switch (fetchMode) {
    case FetchMode.FULL:
      return handler.fetchData(dataSource, connections, context);
    
    case FetchMode.INCREMENTAL:
      if (!previousState?.lastFetchTimestamp) {
        // First run - do full fetch
        return handler.fetchData(dataSource, connections, context);
      }
      
      if (handler.fetchIncremental) {
        return handler.fetchIncremental(
          dataSource,
          previousState.lastFetchTimestamp,
          connections,
          context
        );
      }
      
      // Fall back to date range filter
      return handler.fetchData(dataSource, connections, {
        ...context,
        dateRange: {
          start: previousState.lastFetchTimestamp,
          end: new Date().toISOString(),
        },
      });
    
    case FetchMode.DATE_RANGE:
      if (!context.dateRange) {
        throw new Error("DATE_RANGE fetch mode requires dateRange in context");
      }
      return handler.fetchData(dataSource, connections, context);
  }
}
```

### Scheduled Report Handling

```typescript
async function executeScheduledReport(
  instanceId: string,
  context: ExecutionContext
): Promise<void> {
  // 1. Get instance with last execution state
  const instance = await getTemplateInstanceWithLastExecution(instanceId);
  
  // 2. Determine fetch mode based on schedule and template config
  const fetchStates = instance.lastExecution?.lastFetchTimestamps as Record<string, IncrementalFetchState> || {};
  
  // 3. Execute with incremental fetching where supported
  const dataResults = await Promise.all(
    instance.template.definition.dataSources.map(async (ds) => {
      const handler = getHandlerForDataSource(ds);
      const previousState = fetchStates[ds.id];
      
      return fetchDataWithMode(ds, handler, instance.connections, context, previousState);
    })
  );
  
  // 4. Store new fetch timestamps for next run
  const newFetchStates: Record<string, IncrementalFetchState> = {};
  for (let i = 0; i < dataResults.length; i++) {
    const ds = instance.template.definition.dataSources[i];
    const result = dataResults[i];
    
    newFetchStates[ds.id] = {
      dataSourceId: ds.id,
      lastFetchTimestamp: result.metadata.latestTimestamp || new Date().toISOString(),
      lastCursor: result.cursor,
      lastRecordCount: result.recordCount,
    };
  }
  
  // 5. For incremental mode: merge with existing Qdrant collection
  // For full mode: replace Qdrant collection
  // ...continue with processing and analysis
}
```

---

## Integration with Orchestrator

For complex, multi-step reports that need dynamic planning, we can leverage the existing orchestrator:

### Orchestrator-Powered Report Generation

```typescript
interface OrchestratorReportConfig {
  // Use orchestrator for complex report generation
  useOrchestrator: boolean;
  
  // Orchestrator execution mode
  executionMode: "fast" | "balanced" | "accurate";
  
  // Enable research phase for gathering additional context
  enableResearch: boolean;
  
  // Strategy hint
  suggestedStrategy?: "research-then-generate" | "parallel-gather" | "direct-execution";
}

async function executeOrchestratorReport(
  instance: TemplateInstance,
  context: ExecutionContext
): Promise<ReportResult> {
  const orchestratorInput: OrchestratorWorkflowInput = {
    executionId: `report-${context.executionId}`,
    userId: context.userId,
    organizationId: context.organizationId,
    
    // Build task description from template
    message: buildOrchestratorTaskFromTemplate(instance),
    
    // Pass template-specific config
    executionMode: instance.template.orchestratorConfig?.executionMode || "balanced",
    
    // Enable research for data-gathering reports
    enableResearch: instance.template.orchestratorConfig?.enableResearch ?? true,
    
    // Pre-configure available tools based on instance connections
    enabledMcpConfigIds: Object.values(instance.connections.mcpBindings || {}),
    enabledAgentIds: [], // Can enable specific agents for analysis
    
    // Workspace context for RAG
    workspaceIds: Object.values(instance.connections.workspaceBindings || {}),
  };
  
  // Trigger orchestrator workflow
  const client = await getTemporalClient();
  const workflowId = `orchestrator-report-${context.executionId}`;
  
  const handle = await client.workflow.start("orchestratorExecutionWorkflow", {
    taskQueue: "fabric-worker",
    workflowId,
    args: [orchestratorInput],
  });
  
  // Wait for completion and extract report
  const result = await handle.result();
  
  return {
    content: result.finalResponse,
    artifacts: result.artifacts,
    trajectory: result.trajectory,
  };
}

function buildOrchestratorTaskFromTemplate(instance: TemplateInstance): string {
  const template = instance.template;
  const definition = template.definition;
  
  // Build a clear task description for the orchestrator
  return `Generate a ${template.name} report.

## Report Purpose
${template.description}

## Data Sources to Use
${definition.dataSources.map(ds => `- ${ds.provider}: ${ds.operation}`).join("\n")}

## Analysis Tasks
${definition.aiAgents?.map(agent => `- ${agent.task}`).join("\n") || "Analyze the gathered data and provide insights."}

## Output Format
${template.outputFormat}

## Report Sections
${definition.sections?.map(s => `- ${s.title} (${s.type})`).join("\n") || "Standard report format"}

Generate a comprehensive report following this structure.`;
}
```

---

## Migration Plan

### Phase 1: Schema Updates (Non-Breaking)
1. Add new `type` field to data source definitions (default to "mcp" for backward compat)
2. Add `processing` config to data sources (optional)
3. Add `qdrantCollectionId`, `lastFetchTimestamps`, `dataStats` to executions

### Phase 2: Handler Implementation
1. Implement `McpDataSourceHandler`
2. Implement `IntegrationDataSourceHandler`
3. Implement `WorkspaceDataSourceHandler`
4. Create handler registry and routing

### Phase 3: RAG Pipeline
1. Implement `processDataForRag` function
2. Implement ephemeral Qdrant collection management
3. Implement `executeRagEnhancedAnalysis`
4. Add cleanup for old execution collections

### Phase 4: Update Workflow
1. Update `templateInstanceExecutionWorkflow` to use new handlers
2. Add RAG processing phase
3. Add incremental fetch support
4. Add orchestrator integration option

### Phase 5: UI Updates
1. Update `CreateInstanceDialog` to show explicit connection types
2. Update `TemplateInstanceDetail` to show data source bindings clearly
3. Add execution statistics and RAG info to history

### Phase 6: Template Migration
1. Update system templates to use explicit data source types
2. Add `processing` config to templates that need RAG
3. Document new template format

---

## Example: Slack Weekly Digest Template (v2)

```typescript
{
  name: "Slack Weekly Digest",
  description: "Weekly digest of Slack channel activity with AI-powered analysis",
  templateType: "MONTHLY_REPORT",
  category: "Communication",
  outputFormat: "MARKDOWN",
  
  definition: {
    dataSources: [
      {
        id: "slack-messages",
        type: "INTEGRATION",        // Explicit: uses Workflow Integration
        provider: "slack",
        operation: "get_channel_history",
        config: {
          limit: 5000,
          fetchMode: "incremental", // Only fetch new messages on subsequent runs
        },
        processing: {
          chunkSize: 500,
          chunkOverlap: 50,
          embedForRag: true,        // Enable RAG for large message volumes
          summarizeChunks: false,
        },
      },
    ],
    
    aiAgents: [
      {
        agentId: "default",
        task: `Analyze the Slack messages and create a comprehensive weekly digest.
        
        Include:
        1. Executive Summary (2-3 sentences)
        2. Key Discussions (top 5 topics with brief summaries)
        3. Decisions Made (any decisions or conclusions reached)
        4. Action Items (tasks, follow-ups mentioned)
        5. Team Highlights (shoutouts, achievements)
        6. Trending Topics (frequently mentioned keywords)
        
        Use the RAG context to find the most relevant messages for each section.`,
        outputVariable: "slack_digest",
      },
    ],
    
    sections: [
      {
        id: "header",
        title: "Header",
        type: "text",
        config: {
          template: "# #{{channelName}} Weekly Digest\n\n**Period:** {{weekDate}} - {{TODAY}}\n\n---",
        },
      },
      {
        id: "digest",
        title: "Weekly Digest",
        type: "ai-generated",
        config: {
          outputVariable: "slack_digest",
          wrapperTemplate: "{{content}}",
        },
      },
      {
        id: "footer",
        title: "Footer",
        type: "text",
        config: {
          template: "\n---\n\n📊 *Generated by Fabric Reports*",
        },
      },
    ],
  },
  
  // Connection requirements - explicitly stating what's needed
  connections: {
    integrations: [
      {
        key: "slack",
        name: "Slack",
        description: "Access to Slack channels and messages",
        required: true,
        // Specify required OAuth scopes or API permissions
        requiredScopes: ["channels:history", "groups:history"],
      },
    ],
    // No MCP servers required for this template
    mcpServers: [],
    workspaces: {
      enabled: false, // No document context needed
    },
  },
  
  parameters: {
    required: ["channelId"],
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel ID",
        inputType: "resource-select", // UI will show resource picker
      },
      channelName: {
        type: "string",
        description: "Channel name for display",
      },
      weekDate: {
        type: "string",
        description: "Week start date",
        default: "{{WEEK_START}}",
      },
    },
  },
}
```

---

## Cleanup and Maintenance

### Ephemeral Collection Cleanup

```typescript
// Cleanup job that runs periodically
async function cleanupReportCollections(): Promise<void> {
  // Find executions older than 7 days with collections
  const oldExecutions = await db.templateInstanceExecution.findMany({
    where: {
      createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      qdrantCollectionId: { not: null },
    },
    select: { id: true, qdrantCollectionId: true },
  });
  
  for (const exec of oldExecutions) {
    try {
      // Delete Qdrant collection
      await qdrantClient.deleteCollection(exec.qdrantCollectionId!);
      
      // Clear collection ID from record
      await db.templateInstanceExecution.update({
        where: { id: exec.id },
        data: { qdrantCollectionId: null },
      });
    } catch (error) {
      logger.warn(`Failed to cleanup collection ${exec.qdrantCollectionId}:`, error);
    }
  }
}
```

---

## Summary

This architecture provides:

1. **Explicit Connection Types** - Templates clearly specify MCP vs Integration, eliminating runtime ambiguity
2. **RAG-Based Processing** - Large datasets are chunked, embedded, and stored in Qdrant for efficient AI analysis
3. **Incremental Updates** - Scheduled reports can fetch only new data, reducing API calls and processing time
4. **Orchestrator Integration** - Complex reports can leverage the full orchestrator for multi-step analysis
5. **Clean Separation** - Handlers for each data source type with clear interfaces
6. **Backward Compatibility** - Migration path that doesn't break existing templates

The key insight is that report generation is essentially a specialized form of orchestrated task execution, and we should leverage our existing primitives (MCP tools, Workflow Integrations, RAG, Orchestrator) rather than building parallel systems.

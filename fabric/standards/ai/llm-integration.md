# LLM Integration Standards

## Overview

This document defines standards for integrating Large Language Models (LLMs) into the Fabric Portal. Proper integration ensures reliability, cost control, and optimal user experience.

## When to Apply

- Calling LLM APIs (OpenAI, Anthropic, Azure)
- Building AI-powered features
- Implementing RAG pipelines
- Managing AI provider configurations

## Core Principles

1. **Provider Abstraction** - Support multiple AI providers
2. **Streaming First** - Stream responses for better UX
3. **Cost Awareness** - Track and control costs
4. **Fallbacks** - Handle provider failures gracefully

## ✅ DO

### Use the AI Gateway

**✅ DO**: Route all LLM calls through the AI Gateway

```typescript
// packages/ai/client.ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { experimental_createProviderRegistry } from "ai";

// Create provider registry with all supported providers
export const registry = experimental_createProviderRegistry({
  openai: createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  }),
  anthropic: createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
  // Azure AI Foundry
  azure: createAzureOpenAI({
    endpoint: process.env.AZURE_AI_ENDPOINT,
    apiKey: process.env.AZURE_AI_API_KEY,
  }),
});

// Get model by ID
export function getModel(modelId: string) {
  // modelId format: "provider:model" e.g., "openai:gpt-4-turbo"
  return registry.languageModel(modelId);
}
```

### Streaming Responses

**✅ DO**: Always stream LLM responses

```typescript
// packages/api/modules/ai/procedures/generate.ts
import { streamText } from "ai";
import { getModel } from "@repo/ai";

export const generateTextProcedure = protectedProcedure
  .input(z.object({
    prompt: z.string(),
    model: z.string().default("openai:gpt-4-turbo"),
    systemPrompt: z.string().optional(),
  }))
  .handler(async function* ({ input, context }) {
    const model = getModel(input.model);

    const result = streamText({
      model,
      system: input.systemPrompt,
      prompt: input.prompt,
      // Track usage
      onFinish: async (completion) => {
        await trackUsage({
          userId: context.user.id,
          model: input.model,
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
        });
      },
    });

    // Stream the response
    for await (const chunk of result.textStream) {
      yield { type: "text", content: chunk };
    }

    // Return final metadata
    const usage = await result.usage;
    yield { type: "done", usage };
  });
```

### Structured Output with Zod

**✅ DO**: Use structured outputs for predictable results

```typescript
import { generateObject } from "ai";
import { z } from "zod";

const documentOutlineSchema = z.object({
  title: z.string().describe("Document title"),
  sections: z.array(z.object({
    heading: z.string().describe("Section heading"),
    points: z.array(z.string()).describe("Key points to cover"),
    estimatedWords: z.number().describe("Estimated word count"),
  })).describe("Document sections in order"),
  metadata: z.object({
    targetAudience: z.string(),
    tone: z.enum(["formal", "casual", "technical"]),
  }),
});

export async function generateOutline(
  topic: string,
  context: string,
): Promise<z.infer<typeof documentOutlineSchema>> {
  const result = await generateObject({
    model: getModel("openai:gpt-4-turbo"),
    schema: documentOutlineSchema,
    prompt: `Create a detailed outline for a document about: ${topic}\n\nContext: ${context}`,
  });

  return result.object;
}
```

### Provider Fallbacks

**✅ DO**: Implement fallback chains for reliability

```typescript
import { generateText } from "ai";

const PROVIDER_FALLBACK_CHAIN = [
  "openai:gpt-4-turbo",
  "anthropic:claude-3-opus",
  "azure:gpt-4-turbo",
];

export async function generateWithFallback(
  prompt: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  let lastError: Error | undefined;

  for (const modelId of PROVIDER_FALLBACK_CHAIN) {
    try {
      const result = await generateText({
        model: getModel(modelId),
        prompt,
        ...options,
      });

      return {
        text: result.text,
        model: modelId,
        usage: result.usage,
      };
    } catch (error) {
      lastError = error as Error;
      
      // Log and continue to next provider
      console.error(`Provider ${modelId} failed:`, error);
      
      // Don't fallback for non-retryable errors
      if (isNonRetryableError(error)) {
        throw error;
      }
    }
  }

  throw new Error(`All providers failed. Last error: ${lastError?.message}`);
}

function isNonRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Don't retry content policy violations
    return error.message.includes("content_policy");
  }
  return false;
}
```

### Cost Tracking

**✅ DO**: Track AI usage and costs

```typescript
// packages/ai/lib/usage-tracking.ts
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "openai:gpt-4-turbo": { input: 0.01, output: 0.03 },
  "openai:gpt-4o": { input: 0.005, output: 0.015 },
  "anthropic:claude-3-opus": { input: 0.015, output: 0.075 },
  "anthropic:claude-3-sonnet": { input: 0.003, output: 0.015 },
};

export async function trackUsage(params: {
  userId: string;
  organizationId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  feature?: string;
}): Promise<void> {
  const costs = MODEL_COSTS[params.model] ?? { input: 0, output: 0 };
  
  const totalCost = 
    (params.promptTokens / 1000) * costs.input +
    (params.completionTokens / 1000) * costs.output;

  await db.aiUsage.create({
    data: {
      userId: params.userId,
      organizationId: params.organizationId,
      model: params.model,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      cost: totalCost,
      feature: params.feature,
      timestamp: new Date(),
    },
  });

  // Check usage limits
  await checkUsageLimits(params.userId, params.organizationId);
}
```

### RAG Integration

**✅ DO**: Use RAG for context-aware generation

```typescript
// packages/rag/lib/retrieval.ts
import { embed } from "ai";
import { QdrantClient } from "@qdrant/js-client-rest";

export async function searchRelevantContext(
  query: string,
  options: SearchOptions,
): Promise<RetrievalResult[]> {
  // Generate embedding for query
  const { embedding } = await embed({
    model: getModel("openai:text-embedding-3-small"),
    value: query,
  });

  // Search vector database
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL });
  
  const results = await qdrant.search(options.collection, {
    vector: embedding,
    limit: options.limit ?? 10,
    filter: {
      must: [
        ...(options.userId ? [{ key: "userId", match: { value: options.userId } }] : []),
        ...(options.projectId ? [{ key: "projectId", match: { value: options.projectId } }] : []),
      ],
    },
  });

  return results.map(r => ({
    content: r.payload?.content as string,
    score: r.score,
    metadata: r.payload?.metadata as Record<string, unknown>,
  }));
}

// Usage in generation
export async function generateWithRAG(
  query: string,
  options: GenerateWithRAGOptions,
): Promise<string> {
  // Retrieve relevant context
  const context = await searchRelevantContext(query, {
    collection: options.collection,
    userId: options.userId,
    projectId: options.projectId,
    limit: 5,
  });

  // Format context for prompt
  const contextText = context
    .map((c, i) => `[Source ${i + 1}]\n${c.content}`)
    .join("\n\n");

  // Generate with context
  const result = await generateText({
    model: getModel(options.model),
    system: `Use the following context to answer questions. 
If the context doesn't contain relevant information, say so.

Context:
${contextText}`,
    prompt: query,
  });

  return result.text;
}
```

## ❌ DON'T

### Synchronous Generation

**❌ DON'T**: Block on LLM responses

```typescript
// Bad: Blocking call, no streaming
export async function generateDocument(prompt: string) {
  // ❌ User waits with no feedback
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
  });
  
  return response.choices[0].message.content;
}
```
**Why**: Poor UX, no progress feedback, timeouts likely.

### Exposing API Keys

**❌ DON'T**: Expose API keys to the client

```typescript
// Bad: API key in client-side code
const openai = new OpenAI({
  apiKey: process.env.NEXT_PUBLIC_OPENAI_KEY,  // ❌ Exposed!
  dangerouslyAllowBrowser: true,  // ❌ Red flag!
});
```
**Why**: Keys can be stolen, incur costs, access abuse.

### Unbounded Token Usage

**❌ DON'T**: Allow unlimited context or output

```typescript
// Bad: No limits
const response = await generateText({
  model: getModel("gpt-4"),
  prompt: userInput,  // ❌ Could be huge
  // No maxTokens limit
});
```
**Why**: Cost explosion, API errors, performance issues.

**✅ Better**:

```typescript
// Good: Enforce limits
const response = await generateText({
  model: getModel("gpt-4"),
  prompt: truncateToTokenLimit(userInput, 4000),
  maxTokens: 2000,
});
```

## Patterns & Examples

### Pattern 1: User-Configured AI Provider

**Use Case**: Allow users to bring their own API keys

```typescript
export async function getAIProvider(
  userId: string,
  organizationId?: string,
): Promise<AIProvider> {
  // Check organization config first
  if (organizationId) {
    const orgConfig = await db.organization.findUnique({
      where: { id: organizationId },
      select: {
        aiProvider: true,
        aiGatewayApiKey: true,
        azureAiEndpoint: true,
      },
    });

    if (orgConfig?.aiProvider && orgConfig.aiGatewayApiKey) {
      return createProvider(orgConfig.aiProvider, {
        apiKey: await decrypt(orgConfig.aiGatewayApiKey),
        endpoint: orgConfig.azureAiEndpoint,
      });
    }
  }

  // Check user config
  const userConfig = await db.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiGatewayApiKey: true,
    },
  });

  if (userConfig?.aiProvider && userConfig.aiGatewayApiKey) {
    return createProvider(userConfig.aiProvider, {
      apiKey: await decrypt(userConfig.aiGatewayApiKey),
    });
  }

  // Fall back to system default
  return createProvider("VERCEL_GATEWAY", {
    apiKey: process.env.OPENAI_API_KEY,
  });
}
```

### Pattern 2: Token-Aware Chunking

**Use Case**: Split large content for processing

```typescript
import { encoding_for_model } from "tiktoken";

export function chunkByTokens(
  text: string,
  maxTokens: number,
  overlap: number = 100,
): string[] {
  const encoder = encoding_for_model("gpt-4");
  const tokens = encoder.encode(text);
  
  const chunks: string[] = [];
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + maxTokens, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    chunks.push(encoder.decode(chunkTokens));
    
    // Move forward with overlap
    start = end - overlap;
    if (end === tokens.length) break;
  }

  encoder.free();
  return chunks;
}

// Usage
const chunks = chunkByTokens(longDocument, 3000, 200);
const summaries = await Promise.all(
  chunks.map(chunk => summarize(chunk)),
);
const finalSummary = await combineSummaries(summaries);
```

### Pattern 3: Prompt Templates

**Use Case**: Reusable, configurable prompts

```typescript
// packages/ai/lib/prompts.ts
import Handlebars from "handlebars";

const PROMPT_TEMPLATES = {
  summarize: `Summarize the following {{documentType}} in {{style}} style.
Focus on: {{#each focusAreas}}
- {{this}}
{{/each}}

Content:
{{content}}`,

  analyze: `Analyze the following {{dataType}} and provide insights.
Consider these aspects:
{{#each aspects}}
- {{this}}
{{/each}}

Data:
{{data}}`,
};

export function renderPrompt(
  template: keyof typeof PROMPT_TEMPLATES,
  variables: Record<string, unknown>,
): string {
  const compiled = Handlebars.compile(PROMPT_TEMPLATES[template]);
  return compiled(variables);
}

// Usage
const prompt = renderPrompt("summarize", {
  documentType: "technical specification",
  style: "executive",
  focusAreas: ["key requirements", "timeline", "risks"],
  content: documentContent,
});
```

## Model Selection Guide

| Use Case | Recommended Model | Reasoning |
|----------|------------------|-----------|
| General chat | gpt-4o | Fast, cost-effective |
| Complex reasoning | gpt-4-turbo, claude-3-opus | Best accuracy |
| Code generation | gpt-4-turbo | Strong code understanding |
| Structured output | gpt-4o with JSON mode | Reliable structure |
| Embeddings | text-embedding-3-small | Good quality/cost ratio |
| Long context | claude-3-opus | 200k context window |

## Common Mistakes

1. **No rate limit handling**
   - Problem: 429 errors crash the app
   - Solution: Implement exponential backoff

2. **Ignoring finish reasons**
   - Problem: Incomplete outputs silently accepted
   - Solution: Check `finish_reason` and handle truncation

3. **Prompt injection vulnerability**
   - Problem: User input can manipulate system behavior
   - Solution: Sanitize inputs, use structured outputs

4. **No timeout handling**
   - Problem: Requests hang indefinitely
   - Solution: Set request timeouts, implement cancellation

## MCP (Model Context Protocol) Integration

### MANDATORY: Use AI SDK MCP Client

**✅ ALWAYS**: Use `createMCPClient` from `@ai-sdk/mcp` for ALL MCP server connections.

```typescript
// ✅ CORRECT: Use AI SDK MCP Client
import { createMCPClient } from "@ai-sdk/mcp";

async function callMcpTool(serverUrl: string, accessToken: string, toolName: string, args: Record<string, unknown>) {
  let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  
  try {
    client = await createMCPClient({
      transport: {
        type: "http",  // or "sse" for Server-Sent Events
        url: serverUrl,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    });

    const tools = await client.tools();
    const tool = tools[toolName];
    
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found`);
    }

    return await tool.execute(args, {
      toolCallId: `${toolName}-${Date.now()}`,
      messages: [],
    });
  } finally {
    // Always close the client
    if (client) {
      await client.close();
    }
  }
}
```

**❌ NEVER**: Use raw `fetch` for MCP protocol communication.

```typescript
// ❌ WRONG: Raw fetch with JSON-RPC
const response = await fetch(mcpUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args }
  })
});
```

**Why**: The AI SDK MCP client provides:
- Proper JSON-RPC 2.0 message framing
- Type-safe tool discovery and execution
- Automatic error handling and retry logic
- Proper connection lifecycle management
- Schema validation

### MCP Client Patterns

**Pattern 1: Reusable MCP Client Factory**

```typescript
// packages/mcp/client.ts
import { createMCPClient } from "@ai-sdk/mcp";
import { getMcpConfigById, getValidAccessToken } from "@repo/database";

export async function createMcpClientForConfig(configId: string, userId: string) {
  const config = await getMcpConfigById(configId);
  if (!config) throw new Error("MCP config not found");

  const serverUrl = config.baseUrl || config.mcpServer?.defaultUrl;
  if (!serverUrl) throw new Error("No server URL configured");

  const headers: Record<string, string> = {};
  
  if (config.authType === "API_KEY" || config.authType === "OAUTH2") {
    const accessToken = await getValidAccessToken({ configId, userId });
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
  }

  return await createMCPClient({
    transport: {
      type: config.transport === "SSE" ? "sse" : "http",
      url: serverUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  });
}
```

**Pattern 2: Tool Execution with Error Handling**

```typescript
export async function executeMcpTool<T>(
  client: Awaited<ReturnType<typeof createMCPClient>>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tools = await client.tools();
  const tool = tools[toolName];
  
  if (!tool) {
    const available = Object.keys(tools).join(", ");
    throw new Error(`Tool "${toolName}" not found. Available: ${available}`);
  }

  const result = await tool.execute(args, {
    toolCallId: `${toolName}-${Date.now()}`,
    messages: [],
  });

  // Parse MCP response content
  if (Array.isArray(result)) {
    const textContent = result.find((c: { type: string }) => c.type === "text");
    if (textContent && "text" in textContent) {
      try {
        return JSON.parse(textContent.text as string) as T;
      } catch {
        return textContent.text as T;
      }
    }
  }
  
  return result as T;
}
```

### References

- [AI SDK MCP Client Documentation](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client)
- [MCP Protocol Specification](https://spec.modelcontextprotocol.io/)

## Resources

- [Vercel AI SDK](https://sdk.vercel.ai/docs)
- [OpenAI Best Practices](https://platform.openai.com/docs/guides/production-best-practices)
- [Anthropic Prompt Engineering](https://docs.anthropic.com/claude/docs/prompt-engineering)
- [Tiktoken Token Counting](https://github.com/openai/tiktoken)


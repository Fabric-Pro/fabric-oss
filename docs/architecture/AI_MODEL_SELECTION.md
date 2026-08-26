# AI Model Selection Architecture

This document provides a comprehensive technical reference for Fabric's AI model selection system, covering the AI Model Catalog, gateways, direct providers, preference hierarchy, and provider routing.

## Table of Contents

1. [Overview](#overview)
2. [AI Model Catalog (Single Source of Truth)](#ai-model-catalog-single-source-of-truth)
3. [Architecture Diagram](#architecture-diagram)
4. [AI Gateways vs Direct Providers](#ai-gateways-vs-direct-providers)
5. [Model Selection Hierarchy](#model-selection-hierarchy)
6. [Provider Mapping System](#provider-mapping-system)
7. [Request Flow](#request-flow)
8. [Agent Provider Routing](#agent-provider-routing)
9. [Configuration](#configuration)
10. [Scenarios & Examples](#scenarios--examples)
11. [Special Cases](#special-cases)
12. [Database Schema](#database-schema)

---

## Overview

Fabric's AI model selection system provides a flexible, multi-layered approach to choosing which AI model handles each request. The system supports:

- **Multiple AI Gateways**: Vercel AI Gateway, OpenRouter, Cloudflare AI, etc.
- **Direct Providers**: OpenAI, Anthropic, Groq, DeepSeek with their own API keys
- **Hierarchical Preferences**: Organization-enforced → User → Organization default → System
- **Provider Mappings**: Same model accessible through different providers/gateways
- **Task-Based Selection**: Different models for different task types (chat, reasoning, tool calling)

---

## AI Model Catalog (Single Source of Truth)

The AI Model Catalog (`packages/database/prisma/ai-model-catalog.ts`) is the **single source of truth** for all AI model definitions in the system. Every model name, capability, and provider mapping is defined here.

### Why a Single Source of Truth?

Before the catalog, model names were scattered across:
- Database seed scripts
- API handlers
- Agent configurations
- Frontend components
- External service integrations (Fabric AI, MCP sampling)

This led to bugs when providers changed model names and made it impossible to validate configurations at build time.

### Catalog Structure

```typescript
// packages/database/prisma/ai-model-catalog.ts

// 1. Model definitions with full metadata and provider mappings
export const MODELS: ModelSeedData[] = [
  {
    canonicalName: "llama-3-3-70b",
    displayName: "Llama 3.3 70B",
    capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
    providerMappings: [
      { provider: "GROQ", providerModelId: "llama-3.3-70b-versatile" },
      { provider: "CEREBRAS", providerModelId: "llama-3.3-70b" },
      { provider: "VERCEL_GATEWAY", providerModelId: "meta/llama-3.3-70b" },
    ],
  },
  // ... 50+ models
];

// 2. Default models by task type (compile-time constants)
export const DEFAULT_MODELS = {
  SIMPLE: "gpt-4o-mini",
  COMPLEX: "gpt-4o",
  CHAT: "gpt-4o",
  TOOL_CALLING: "gpt-4o",
  REASONING: "o1",
  EMBEDDING: "text-embedding-3-small",
} as const;

// 3. Task defaults per provider
export const TASK_DEFAULTS: TaskDefaultSeed[] = [
  { taskType: "SIMPLE", provider: "GROQ", canonicalName: "llama-3-1-8b" },
  { taskType: "COMPLEX", provider: "GROQ", canonicalName: "llama-3-3-70b" },
  // ... per-provider defaults
];

// 4. Helper functions
export function getProviderModelId(canonicalName: string, provider: AIProvider): string | undefined;
export function resolveModelAlias(alias: string): string;
export function getModelCapabilitiesFromCatalog(modelId: string): ModelCapabilities;
```

### Usage Examples

```typescript
import {
  DEFAULT_MODELS,
  getProviderModelId,
  resolveModelAlias,
} from "@repo/database/prisma/ai-model-catalog";

// Use compile-time defaults
const defaultChatModel = DEFAULT_MODELS.CHAT;  // "gpt-4o"

// Get provider-specific model ID
const groqModel = getProviderModelId("llama-3-3-70b", "GROQ");
// Returns: "llama-3.3-70b-versatile"

// Resolve user-friendly aliases
const model = resolveModelAlias("claude");  // Returns: "claude-sonnet-4-5"
```

### Validation Tests

```bash
pnpm --filter @repo/database test -- --testPathPattern="ai-model-catalog"

# Output:
# ✅ OPENAI_DIRECT: 11 models valid
# ✅ GROQ: 9 models valid
# ✅ CEREBRAS: 4 models valid
# ✅ VERCEL_GATEWAY: 22 models valid
# TOTAL: 100 valid, 0 invalid
```

### Files Using the Catalog

| File | Usage |
|------|-------|
| `packages/ai/index.ts` | Dynamic model resolution |
| `packages/fabric-ai/client.ts` | Fabric AI default models |
| `packages/fabric-ai/full-executor.ts` | Full mode execution defaults |
| `packages/mcp/lib/sampling.ts` | MCP sampling model selection |
| `packages/database/prisma/seed-agent-templates.ts` | Agent template suggested models |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER REQUEST                                       │
│                    (Task Type: CHAT, COMPLEX, REASONING, etc.)              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      DYNAMIC MODEL SELECTOR                                  │
│                   (selectModelDynamic function)                              │
│                                                                              │
│  Inputs:                                                                     │
│  • taskType (SIMPLE, COMPLEX, REASONING, CHAT, TOOL_CALLING, etc.)         │
│  • complexity (simple, medium, complex)                                      │
│  • requiresToolCalling (boolean)                                            │
│  • preferredProvider (from user's default AI provider config)               │
│  • context { userId, organizationId, agentId }                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PREFERENCE RESOLUTION                                     │
│               (getEffectiveModelPreference function)                         │
│                                                                              │
│  Priority Order (highest to lowest):                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ 1. Org Enforced Preference (enforceForMembers=true)                    │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ 2. User Preference for Specific Agent                                  │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ 3. Org Preference for Specific Agent                                   │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ 4. User Preference for Task Type                                       │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ 5. Org Preference for Task Type                                        │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ 6. System Default for Task Type                                        │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ 7. Hardcoded Fallback (env vars or built-in defaults)                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PROVIDER MAPPING SELECTION                                │
│                                                                              │
│  Model: gpt-4o                                                              │
│  Available Mappings:                                                         │
│  ┌──────────────────┬─────────────────────┐                                 │
│  │ Provider         │ Provider Model ID    │                                 │
│  ├──────────────────┼─────────────────────┤                                 │
│  │ OPENAI_DIRECT    │ gpt-4o              │                                 │
│  │ VERCEL_GATEWAY   │ openai/gpt-4o       │                                 │
│  │ OPENROUTER       │ openai/gpt-4o       │                                 │
│  │ AZURE_AI_FOUNDRY │ gpt-4o-deployment   │                                 │
│  └──────────────────┴─────────────────────┘                                 │
│                                                                              │
│  Selection Priority:                                                         │
│  1. overrideProvider (from preference) → Explicit user choice for model     │
│  2. preferredProvider (parameter) → User's default gateway/provider         │
│  3. First available mapping                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      MODEL INSTANTIATION                                     │
│                      (getModel function)                                     │
│                                                                              │
│  Input: "groq/llama-3.3-70b-versatile" + { apiKey }                         │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Gateway Normalization                             │    │
│  │  • groq/openai/gpt-oss-120b → openai/gpt-oss-120b                   │    │
│  │  • Strips outer provider prefix for nested model names              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                    ┌─────────────────┼─────────────────┐                    │
│                    ▼                 ▼                 ▼                    │
│  ┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────────┐       │
│  │ Custom API Key      │ │ Global Gateway  │ │ Direct Providers    │       │
│  │ (per-user/org)      │ │ (env variable)  │ │ (env variables)     │       │
│  │                     │ │                 │ │                     │       │
│  │ createGateway({     │ │ gatewayProvider │ │ groqProvider()      │       │
│  │   apiKey: custom    │ │ (AI_GATEWAY_    │ │ openaiProvider()    │       │
│  │ })                  │ │  API_KEY)       │ │ anthropicProvider() │       │
│  └─────────────────────┘ └─────────────────┘ └─────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AI PROVIDER API                                       │
│                                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │  OpenAI  │  │ Anthropic│  │   Groq   │  │ DeepSeek │  │   etc.   │      │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## AI Gateways vs Direct Providers

### AI Gateways

AI Gateways act as intermediaries that route requests to multiple AI providers through a unified API.

**Vercel AI Gateway** (Primary):
```
┌─────────────────────────────────────────────────────────────────┐
│                    VERCEL AI GATEWAY                             │
│                                                                  │
│  API Key: vck_xxx...                                            │
│  Endpoint: https://ai-gateway.vercel.sh/v1                      │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Model Routing (based on prefix):                          │  │
│  │                                                           │  │
│  │  openai/gpt-4o        → OpenAI API                       │  │
│  │  anthropic/claude-3.5 → Anthropic API                    │  │
│  │  groq/llama-3.3-70b   → Groq API                         │  │
│  │  deepseek/deepseek-r1 → DeepSeek API                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Benefits:                                                       │
│  • Centralized monitoring & cost tracking                       │
│  • Rate limiting & provider fallbacks                           │
│  • Single API key for all providers                             │
│  • Request/response logging                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Other Supported Gateways**:
- OpenRouter (`OPENROUTER`)
- Cloudflare AI (`CLOUDFLARE_AI`)
- Azure AI Foundry (`AZURE_AI_FOUNDRY`)
- AWS Bedrock (`AWS_BEDROCK`)
- Google Vertex AI (`GOOGLE_VERTEX_AI`)

### Direct Providers

Direct providers connect to AI services without an intermediary gateway.

```
┌─────────────────────────────────────────────────────────────────┐
│                    DIRECT PROVIDERS                              │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ OPENAI_DIRECT   │  │ANTHROPIC_DIRECT │  │     GROQ        │  │
│  │                 │  │                 │  │                 │  │
│  │ API Key:        │  │ API Key:        │  │ API Key:        │  │
│  │ sk-xxx...       │  │ sk-ant-xxx...   │  │ gsk_xxx...      │  │
│  │                 │  │                 │  │                 │  │
│  │ Endpoint:       │  │ Endpoint:       │  │ Endpoint:       │  │
│  │ api.openai.com  │  │ api.anthropic   │  │ api.groq.com    │  │
│  │                 │  │ .com            │  │                 │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐                       │
│  │    DEEPSEEK     │  │   MISTRAL_AI    │                       │
│  │                 │  │                 │                       │
│  │ API Key:        │  │ API Key:        │                       │
│  │ sk-xxx...       │  │ xxx...          │                       │
│  └─────────────────┘  └─────────────────┘                       │
│                                                                  │
│  When to use:                                                    │
│  • Organization has direct contracts with providers             │
│  • Need provider-specific features not in gateway               │
│  • Lower latency (no gateway hop)                               │
│  • Cost savings (no gateway markup)                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Model Selection Hierarchy

The system uses a cascading priority system to determine which model to use:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     MODEL SELECTION HIERARCHY                                │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 1: Organization Enforced Preference                        │    │
│  │                                                                     │    │
│  │ • enforceForMembers = true                                         │    │
│  │ • All org members MUST use this model                              │    │
│  │ • Cannot be overridden by user preferences                         │    │
│  │                                                                     │    │
│  │ Use Case: Compliance - "All chat must use Claude for safety"       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 2: User Preference for Specific Agent                      │    │
│  │                                                                     │    │
│  │ • User sets preference for a particular agent                      │    │
│  │ • Example: "Use GPT-4o for the Code Review Agent"                  │    │
│  │                                                                     │    │
│  │ Use Case: User prefers specific model for specific workflows       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 3: Organization Preference for Specific Agent              │    │
│  │                                                                     │    │
│  │ • Org default for a particular agent (not enforced)                │    │
│  │ • Users can override                                               │    │
│  │                                                                     │    │
│  │ Use Case: "Our API Agent should default to Claude"                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 4: User Preference for Task Type                           │    │
│  │                                                                     │    │
│  │ • User sets preference for task category                           │    │
│  │ • Task Types: SIMPLE, COMPLEX, REASONING, CHAT, TOOL_CALLING       │    │
│  │                                                                     │    │
│  │ Use Case: "I prefer Claude for all reasoning tasks"                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 5: Organization Preference for Task Type                   │    │
│  │                                                                     │    │
│  │ • Org default for task category (not enforced)                     │    │
│  │ • Applied when user has no preference                              │    │
│  │                                                                     │    │
│  │ Use Case: "Our org defaults to Groq for fast responses"            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 6: System Default for Task Type                            │    │
│  │                                                                     │    │
│  │ • Database-configured defaults from AI Model Catalog               │    │
│  │ • Seeded via: pnpm --filter @repo/database seed:ai-models          │    │
│  │                                                                     │    │
│  │ Defaults (from ai-model-catalog.ts):                               │    │
│  │ • SIMPLE: gpt-4o-mini (OpenAI) / llama-3-1-8b (Groq/Cerebras)     │    │
│  │ • COMPLEX: gpt-4o (OpenAI) / llama-3-3-70b (Groq/Cerebras)        │    │
│  │ • REASONING: o1 (OpenAI) / deepseek-r1 (Groq/DeepSeek)            │    │
│  │ • CHAT: gpt-4o (OpenAI) / llama-3-3-70b (Groq/Cerebras)           │    │
│  │ • TOOL_CALLING: gpt-4o (OpenAI) / gpt-oss-120b (Groq/Cerebras)    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PRIORITY 7: Error (NO Hardcoded Fallbacks)                          │    │
│  │                                                                     │    │
│  │ • System throws clear error if no configuration found              │    │
│  │ • Example: "No model configured for CEREBRAS + TOOL_CALLING"       │    │
│  │ • Prevents silent failures with wrong models                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Provider Mapping System

Each canonical model can have multiple provider mappings, allowing the same model to be accessed through different services:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PROVIDER MAPPING EXAMPLE                                 │
│                                                                              │
│  Canonical Model: gpt-4o (OpenAI GPT-4 Omni)                                │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Provider Mappings:                                                   │    │
│  │                                                                     │    │
│  │ ┌─────────────────┬─────────────────────┬────────────────────────┐ │    │
│  │ │ Provider        │ Provider Model ID    │ When to Use            │ │    │
│  │ ├─────────────────┼─────────────────────┼────────────────────────┤ │    │
│  │ │ OPENAI_DIRECT   │ gpt-4o              │ Direct OpenAI access   │ │    │
│  │ │ VERCEL_GATEWAY  │ openai/gpt-4o       │ Through Vercel Gateway │ │    │
│  │ │ OPENROUTER      │ openai/gpt-4o       │ Through OpenRouter     │ │    │
│  │ │ AZURE_AI_FOUNDRY│ gpt-4o-deployment   │ Azure deployment       │ │    │
│  │ └─────────────────┴─────────────────────┴────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Canonical Model: llama-3.3-70b-versatile (Meta Llama)                      │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Provider Mappings:                                                   │    │
│  │                                                                     │    │
│  │ ┌─────────────────┬─────────────────────────────┬────────────────┐ │    │
│  │ │ Provider        │ Provider Model Id            │ Notes          │ │    │
│  │ ├─────────────────┼─────────────────────────────┼────────────────┤ │    │
│  │ │ GROQ            │ llama-3.3-70b-versatile     │ Native Groq    │ │    │
│  │ │ VERCEL_GATEWAY  │ groq/llama-3.3-70b-versatile│ Via Gateway    │ │    │
│  │ │ TOGETHER_AI     │ meta-llama/Llama-3.3-70B    │ Together naming│ │    │
│  │ │ OPENROUTER      │ meta-llama/llama-3.3-70b    │ OpenRouter     │ │    │
│  │ └─────────────────┴─────────────────────────────┴────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Special Case: Groq OpenAI Models (openai/gpt-oss-120b)                     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ These are OpenAI's open-source models hosted on Groq's infra:       │    │
│  │                                                                     │    │
│  │ ┌─────────────────┬────────────────────────────┬─────────────────┐ │    │
│  │ │ Provider        │ Provider Model Id           │ Notes           │ │    │
│  │ ├─────────────────┼────────────────────────────┼─────────────────┤ │    │
│  │ │ GROQ            │ openai/gpt-oss-120b        │ Native name     │ │    │
│  │ │ VERCEL_GATEWAY  │ groq/openai/gpt-oss-120b   │ 3-level path!   │ │    │
│  │ └─────────────────┴────────────────────────────┴─────────────────┘ │    │
│  │                                                                     │    │
│  │ ⚠️  Gateway Normalization Required:                                 │    │
│  │ groq/openai/gpt-oss-120b → openai/gpt-oss-120b                     │    │
│  │ (Strips outer groq/ prefix before sending to gateway)              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Request Flow

### Complete Request Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE REQUEST FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

  1. API/Agent Request
  ┌──────────────────────┐
  │ generateText({       │
  │   prompt: "...",     │
  │   taskType: "CHAT"   │
  │ })                   │
  └──────────┬───────────┘
             │
             ▼
  2. Model Selection (model-selector.ts)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ async function getAiModel(userId, organizationId, hasTools) {            │
  │                                                                          │
  │   // Detect user's configured AI provider                                │
  │   const providerConfig = await resolveAIProviderApiKey(userId, orgId);   │
  │   // → { provider: "VERCEL_GATEWAY", apiKey: "vck_xxx" }                 │
  │                                                                          │
  │   // Get model from database using dynamic selection                     │
  │   const modelResult = await selectModelDynamic({                         │
  │     taskType: "CHAT",                                                    │
  │     preferredProvider: "VERCEL_GATEWAY"                                  │
  │   }, { userId, organizationId });                                        │
  │   // → { providerModelId: "groq/llama-3.3-70b-versatile",               │
  │   //     provider: "VERCEL_GATEWAY", source: "user_task" }              │
  │                                                                          │
  │   return getConfiguredAIModel({ userId, organizationId, modelName });    │
  │ }                                                                        │
  └──────────────────────────────────────────────────────────────────────────┘
             │
             ▼
  3. AI Gateway Resolution (ai-gateway.ts)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ async function getConfiguredAIModel(config) {                            │
  │   const resolved = await resolveAIProviderApiKey(userId, organizationId);│
  │   // → { apiKey: "vck_xxx", provider: "VERCEL_GATEWAY",                  │
  │   //     baseUrl: null, source: "user" }                                 │
  │                                                                          │
  │   return getModel(modelName, { apiKey: resolved.apiKey });               │
  │ }                                                                        │
  └──────────────────────────────────────────────────────────────────────────┘
             │
             ▼
  4. Model Instantiation (packages/ai/index.ts)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ function getModel(modelName, context) {                                  │
  │   // modelName = "groq/llama-3.3-70b-versatile"                         │
  │                                                                          │
  │   // Normalize for gateway (handles nested prefixes)                     │
  │   const normalized = normalizeModelForGateway(modelName);                │
  │   // → "groq/llama-3.3-70b-versatile" (unchanged)                       │
  │   // OR "openai/gpt-oss-120b" (if was "groq/openai/gpt-oss-120b")       │
  │                                                                          │
  │   if (context?.apiKey) {                                                 │
  │     const gateway = getGatewayProvider(context.apiKey);                  │
  │     return gateway(formatModelName(normalized));                         │
  │   }                                                                      │
  │   // ...fallback to direct providers                                     │
  │ }                                                                        │
  └──────────────────────────────────────────────────────────────────────────┘
             │
             ▼
  5. Gateway Request
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ Vercel AI Gateway                                                        │
  │                                                                          │
  │ Request:                                                                 │
  │ POST https://ai-gateway.vercel.sh/v1/chat/completions                   │
  │ Authorization: Bearer vck_xxx                                            │
  │ Body: { model: "groq/llama-3.3-70b-versatile", messages: [...] }        │
  │                                                                          │
  │ Gateway parses "groq/" prefix → routes to Groq API                      │
  └──────────────────────────────────────────────────────────────────────────┘
             │
             ▼
  6. Provider API
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ Groq API (api.groq.com)                                                  │
  │                                                                          │
  │ Request:                                                                 │
  │ POST https://api.groq.com/v1/chat/completions                           │
  │ Authorization: Bearer gsk_xxx (gateway's Groq key)                       │
  │ Body: { model: "llama-3.3-70b-versatile", messages: [...] }             │
  └──────────────────────────────────────────────────────────────────────────┘
             │
             ▼
  7. Response flows back through the same chain
```

---

## Agent Provider Routing

Agents (LangGraph, CopilotKit-based) receive AI credentials through a configurable passed from the CopilotKit route. The system supports two modes:

### Mode 1: Token Exchange (Default Provider)

When there's no override provider set, agents use secure token exchange:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TOKEN EXCHANGE FLOW (Default Provider)                    │
│                                                                              │
│  CopilotKit Route                    Agent (Unified Server)                  │
│  ─────────────────                   ─────────────────────                   │
│  1. Issue AI token (JWT)        →    2. Receive ai_token in configurable    │
│                                       3. Extract token from headers          │
│                                       4. Call /api/ai/keys/exchange          │
│                                       5. Get DEFAULT provider's API key      │
│                                       6. Use API key for AI calls            │
│                                                                              │
│  Security: Agents never see raw API keys until exchange                      │
│  Limitation: Token exchange only returns DEFAULT provider config             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Mode 2: Direct Pass-Through (Override Provider)

When a user sets an `overrideProvider` for a task type, the system bypasses token exchange:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DIRECT PASS-THROUGH FLOW (Override Provider)              │
│                                                                              │
│  CopilotKit Route                    Agent (Unified Server)                  │
│  ─────────────────                   ─────────────────────                   │
│  1. Check task preference            4. Check: ai_api_key in configurable?  │
│  2. Found overrideProvider?     →    5. YES: Use ai_api_key directly        │
│  3. YES: Fetch override API key      6. Skip token exchange                 │
│     Pass decrypted ai_api_key        7. Call AI provider with override key  │
│     in configurable                                                          │
│                                                                              │
│  Why needed: Token exchange only knows about default provider                │
│  Benefit: Respects user's task-specific provider preferences                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Details

**CopilotKit Route** (`apps/web/app/api/copilotkit/route.ts`):

```typescript
// Check for task-specific provider override
const taskPreference = await getUserModelPreference(userId, "TOOL_CALLING");
const overrideProvider = taskPreference?.overrideProvider;

// If override, fetch that provider's config
let effectiveProvider = providerConfig.provider;
let effectiveApiKey = providerConfig.apiKey;

if (overrideProvider) {
  const overrideConfig = await db.user_cloud_provider_config.findFirst({
    where: { userId, provider: overrideProvider, enabled: true },
  });

  if (overrideConfig?.config?.apiKey) {
    effectiveProvider = overrideProvider;
    effectiveApiKey = overrideConfig.config.apiKey;
  }
}

// Pass to agents
const properties = {
  ai_provider: effectiveProvider,
  ai_token: aiToken, // Fallback for default provider
  // Only include ai_api_key when override is set
  ...(overrideProvider && { ai_api_key: decryptApiKey(effectiveApiKey) }),
  ai_model: aiModelString,
  ai_gateway_url: aiGatewayUrl,
};
```

**Unified Server** (`packages/agent-core/src/unified-server.ts`):

```typescript
// Priority: passed ai_api_key (override) > token exchange (default)
const runtimeConfig = {
  configurable: {
    ai_api_key:
      configurable.ai_api_key ||     // Override provider's key (direct)
      context.ai_api_key ||          // From CopilotKit context
      properties.ai_api_key ||       // From CopilotKit properties
      exchangedCredentials?.apiKey,  // Token exchange (fallback)
    // ...other config
  },
};
```

### Decision Matrix

| Override Set | ai_api_key Passed | Source Used | Description |
|--------------|-------------------|-------------|-------------|
| No | No | Token Exchange | Default flow - secure token exchange |
| Yes | Yes | Direct | Override provider's key used directly |
| Yes | No (key missing) | Token Exchange | Fallback to default when override unavailable |

### Logging

The system logs which mode was used:

```
[UnifiedServer] AI config: { aiConfigSource: "direct-override", ... }
// or
[UnifiedServer] AI config: { aiConfigSource: "token-exchange", ... }
```

---

## Configuration

### Environment Variables

```bash
# Primary Gateway (recommended)
AI_GATEWAY_API_KEY=vck_xxxxx        # Vercel AI Gateway key

# Direct Provider Fallbacks (optional)
OPENAI_API_KEY=sk-xxxxx             # Direct OpenAI
ANTHROPIC_API_KEY=sk-ant-xxxxx      # Direct Anthropic
GROQ_API_KEY=gsk_xxxxx              # Direct Groq
DEEPSEEK_API_KEY=sk-xxxxx           # Direct DeepSeek
```

> There is no env-var fallback-model layer. Model resolution is fully dynamic (`selectModelDynamic` in `dynamic-model-selector.ts`); when no model can be resolved it throws rather than falling back to a hardcoded default ("NO HARDCODED FALLBACKS").

### Database Configuration

Users and organizations can configure providers through the Settings UI:

**User Provider Config** (`user_cloud_provider_config`):
```json
{
  "provider": "VERCEL_GATEWAY",
  "isDefault": true,
  "enabled": true,
  "config": {
    "apiKey": "encrypted_vck_xxxxx",
    "enabledProviders": ["openai", "anthropic", "groq", "deepseek"]
  }
}
```

**User Model Preference** (`user_model_preference`):
```json
{
  "taskType": "CHAT",
  "modelId": "claude-3.5-sonnet",
  "overrideProvider": "ANTHROPIC_DIRECT"  // Optional: force specific provider
}
```

---

## Scenarios & Examples

### Scenario 1: OpenAI Direct

User has only OpenAI configured as a direct provider.

```
Configuration:
├── User Provider: OPENAI_DIRECT (apiKey: sk-xxx)
├── User Preference: None
└── System Default: gpt-4o for CHAT

Request: taskType = "CHAT"

Flow:
1. selectModelDynamic → gpt-4o (system default)
2. preferredProvider = OPENAI_DIRECT
3. Provider mapping: OPENAI_DIRECT → "gpt-4o"
4. getModel("gpt-4o", { apiKey: "sk-xxx" })
5. → Direct OpenAI API call with "gpt-4o"

Result: Direct call to api.openai.com
```

### Scenario 2: OpenAI via Vercel Gateway

User has Vercel AI Gateway configured with OpenAI enabled.

```
Configuration:
├── User Provider: VERCEL_GATEWAY (apiKey: vck_xxx, enabledProviders: ["openai"])
├── User Preference: gpt-4o for CHAT
└── Provider Mapping: gpt-4o → VERCEL_GATEWAY → "openai/gpt-4o"

Request: taskType = "CHAT"

Flow:
1. selectModelDynamic → gpt-4o (user preference)
2. preferredProvider = VERCEL_GATEWAY
3. Provider mapping: VERCEL_GATEWAY → "openai/gpt-4o"
4. getModel("openai/gpt-4o", { apiKey: "vck_xxx" })
5. Gateway routes "openai/" to OpenAI API

Result: Call through Vercel Gateway to OpenAI
```

### Scenario 3: Groq Model via Vercel Gateway

User wants fast Groq inference through their gateway.

```
Configuration:
├── User Provider: VERCEL_GATEWAY (apiKey: vck_xxx, enabledProviders: ["groq"])
├── User Preference: llama-3.3-70b-versatile for COMPLEX
└── Provider Mapping: llama → VERCEL_GATEWAY → "groq/llama-3.3-70b-versatile"

Request: taskType = "COMPLEX"

Flow:
1. selectModelDynamic → llama-3.3-70b-versatile
2. preferredProvider = VERCEL_GATEWAY
3. Provider mapping: VERCEL_GATEWAY → "groq/llama-3.3-70b-versatile"
4. getModel("groq/llama-3.3-70b-versatile", { apiKey: "vck_xxx" })
5. Gateway routes "groq/" to Groq API

Result: Call through Vercel Gateway to Groq
```

### Scenario 4: OpenAI Model on Groq (Special Case)

Groq hosts some OpenAI open-source models with nested prefixes.

```
Configuration:
├── User Provider: VERCEL_GATEWAY (apiKey: vck_xxx)
├── User Preference: openai/gpt-oss-120b for TOOL_CALLING
└── Provider Mapping: gpt-oss → VERCEL_GATEWAY → "groq/openai/gpt-oss-120b"

Request: taskType = "TOOL_CALLING"

Flow:
1. selectModelDynamic → openai/gpt-oss-120b
2. Provider mapping: VERCEL_GATEWAY → "groq/openai/gpt-oss-120b"
3. getModel("groq/openai/gpt-oss-120b", { apiKey: "vck_xxx" })
4. ⚠️ normalizeModelForGateway strips "groq/" prefix
5. Gateway receives "openai/gpt-oss-120b"
6. Gateway routes to Groq (which hosts this model)

Result: "openai/gpt-oss-120b" sent to Gateway → Groq
```

### Scenario 5: Organization Enforcement

Organization mandates a specific model for compliance.

```
Configuration:
├── Org Provider: ANTHROPIC_DIRECT
├── Org Preference: claude-3.5-sonnet for CHAT (enforceForMembers: true)
├── User Preference: gpt-4o for CHAT (ignored!)
└── Provider Mapping: claude → ANTHROPIC_DIRECT → "claude-3.5-sonnet"

Request: taskType = "CHAT" (from org member)

Flow:
1. selectModelDynamic checks org enforcement FIRST
2. → claude-3.5-sonnet (org enforced, user pref ignored)
3. Provider mapping: ANTHROPIC_DIRECT → "claude-3.5-sonnet"
4. getModel("claude-3.5-sonnet", { apiKey: org_anthropic_key })

Result: Anthropic Claude used regardless of user preference
```

### Scenario 6: Fallback Chain

No configuration exists, system uses defaults.

```
Configuration:
├── User Provider: None
├── Org Provider: None
├── User Preference: None
├── Org Preference: None
├── System Default: llama-3.3-70b-versatile for CHAT
└── Environment: AI_GATEWAY_API_KEY=vck_xxx

Request: taskType = "CHAT"

Flow:
1. selectModelDynamic → no user/org preference
2. → System default: llama-3.3-70b-versatile
3. No preferredProvider, use first mapping
4. formatModelName → "groq/llama-3.3-70b-versatile"
5. Global gateway provider used (from env)

Result: System default through environment gateway
```

### Scenario 7: Same Provider via Multiple Routes (Multi-Gateway)

User has Groq configured as a direct provider AND through multiple gateways.

```
Configuration:
├── Direct Provider: GROQ (API Key: gsk_xxx, isDefault: false)
├── Vercel AI Gateway (API Key: vck_xxx, isDefault: true, enabledProviders: [groq, openai])
└── Cloudflare AI Gateway (API Key: cf_xxx, isDefault: false, enabledProviders: [groq, anthropic])

Model: llama-3.3-70b-versatile
Available Provider Mappings:
├── GROQ → "llama-3.3-70b-versatile"
├── VERCEL_GATEWAY → "groq/llama-3.3-70b-versatile"
└── CLOUDFLARE_AI → "@cf/meta/llama-3.3-70b-instruct"

Request: taskType = "CHAT"
```

**Routing Decision Flow:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MULTI-ROUTE PROVIDER SCENARIO                        │
│                                                                              │
│  Step 1: Get User's DEFAULT Provider                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Query: user_cloud_provider_config WHERE isDefault = true               │ │
│  │ Result: VERCEL_GATEWAY (vck_xxx)                                       │ │
│  │ This becomes the "preferredProvider" for model selection               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  Step 2: Select Provider Mapping                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Priority Order:                                                        │ │
│  │                                                                        │ │
│  │ 1. overrideProvider (from user_model_preference)                      │ │
│  │    → If user set "use GROQ direct for this model" → Use GROQ mapping  │ │
│  │    → If user set "use CLOUDFLARE_AI" → Use Cloudflare mapping         │ │
│  │                                                                        │ │
│  │ 2. preferredProvider (user's default provider = VERCEL_GATEWAY)       │ │
│  │    → Check: Does mapping exist for VERCEL_GATEWAY? Yes                │ │
│  │    → Use VERCEL_GATEWAY mapping: "groq/llama-3.3-70b-versatile"       │ │
│  │                                                                        │ │
│  │ 3. First available mapping (fallback)                                  │ │
│  │    → Only used if no preference matches                               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  Step 3: Result                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Selected: VERCEL_GATEWAY → "groq/llama-3.3-70b-versatile"             │ │
│  │ API Key: vck_xxx (Vercel Gateway key)                                 │ │
│  │ Request Path: App → Vercel Gateway → Groq API                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Decision Matrix for this Configuration:**

| isDefault Provider | overrideProvider | Route Used | Request Path |
|--------------------|------------------|------------|--------------|
| VERCEL_GATEWAY | (none) | VERCEL_GATEWAY | App → Vercel → Groq |
| VERCEL_GATEWAY | GROQ | GROQ (direct) | App → Groq API |
| VERCEL_GATEWAY | CLOUDFLARE_AI | CLOUDFLARE_AI | App → Cloudflare → Groq |
| GROQ | (none) | GROQ (direct) | App → Groq API |
| CLOUDFLARE_AI | (none) | CLOUDFLARE_AI | App → Cloudflare → Groq |

**Why Configure Multiple Routes to Same Provider?**

| Route | Use Case |
|-------|----------|
| **Direct Groq** | Lower latency, no gateway overhead, direct billing relationship |
| **Via Vercel Gateway** | Centralized logging, unified cost tracking, automatic fallbacks |
| **Via Cloudflare AI** | Edge caching, geographic routing, Cloudflare ecosystem integration |

**Key Points:**
- The `isDefault: true` flag on provider config determines automatic routing
- `overrideProvider` in model preferences overrides the default for specific models
- Multiple routes to the same provider allow flexibility for different use cases
- The system always picks ONE route - it doesn't load balance between them

### Scenario 8: Agent with Task-Specific Override Provider

User has Vercel Gateway as default but wants to use OpenAI Direct specifically for TOOL_CALLING tasks.

```
Configuration:
├── User Provider (default): VERCEL_GATEWAY (apiKey: vck_xxx, isDefault: true)
├── User Provider: OPENAI_DIRECT (apiKey: sk-xxx, isDefault: false, enabled: true)
├── User Preference for TOOL_CALLING: gpt-4o with overrideProvider: OPENAI_DIRECT
└── User Preference for CHAT: None (uses default)

Request: Agent needs to call tools (taskType = "TOOL_CALLING")

Flow:
1. CopilotKit route receives agent request
2. Checks task preference for TOOL_CALLING
3. Finds overrideProvider = OPENAI_DIRECT
4. Fetches OPENAI_DIRECT config from user_cloud_provider_config
5. Decrypts API key: sk-xxx
6. Passes ai_api_key directly in agent's configurable
7. Agent receives: { ai_api_key: "sk-xxx", ai_provider: "OPENAI_DIRECT", ... }
8. Agent uses key directly (skips token exchange)
9. Direct call to api.openai.com

Result: Agent uses OpenAI Direct, not Vercel Gateway
```

**Without This Feature:**

```
Flow (bug):
1. CopilotKit issues ai_token for token exchange
2. Agent calls /api/ai/keys/exchange
3. Token exchange returns: VERCEL_GATEWAY config (default!)
4. Agent uses Vercel Gateway, ignoring user's override preference

Result: Agent routes through Vercel Gateway (wrong!)
```

**The Fix Enables:**

| Task Type | User's Override | Actual Provider Used |
|-----------|-----------------|---------------------|
| CHAT | None | VERCEL_GATEWAY (default) |
| TOOL_CALLING | OPENAI_DIRECT | OPENAI_DIRECT ✓ |
| REASONING | ANTHROPIC_DIRECT | ANTHROPIC_DIRECT ✓ |
| SIMPLE | None | VERCEL_GATEWAY (default) |

---

## Special Cases

### Reasoning Models

Models using DeepSeek R1 architecture return thinking in `<think>` tags:

```
┌─────────────────────────────────────────────────────────────────┐
│ REASONING MODEL MIDDLEWARE                                       │
│                                                                  │
│ Models Affected:                                                 │
│ • deepseek-r1-*                                                 │
│ • deepseek-reasoner                                             │
│ • *-r1-distill-*                                                │
│                                                                  │
│ What happens:                                                    │
│ 1. Model outputs: <think>reasoning here</think>actual response  │
│ 2. Middleware extracts reasoning to separate field              │
│ 3. Response: { text: "actual response",                         │
│                reasoning: "reasoning here" }                    │
│                                                                  │
│ Exception: DeepSeek direct provider has native support          │
│ (no middleware needed)                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Gateway Normalization

Models with nested prefixes need special handling:

```
┌─────────────────────────────────────────────────────────────────┐
│ GATEWAY NORMALIZATION                                            │
│                                                                  │
│ Problem:                                                         │
│ Vercel Gateway expects: provider/model (2 levels)               │
│ Groq OSS models have: groq/openai/gpt-oss-120b (3 levels)       │
│                                                                  │
│ Solution:                                                        │
│ normalizeModelForGateway() strips outer prefix:                  │
│                                                                  │
│ Input:  "groq/openai/gpt-oss-120b"                              │
│ Output: "openai/gpt-oss-120b"                                   │
│                                                                  │
│ Gateway then routes "openai/gpt-oss-120b" to Groq               │
│ (Groq hosts this model with that exact identifier)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Key Tables

```sql
-- Model catalog
CREATE TABLE ai_model (
  id TEXT PRIMARY KEY,
  canonical_name TEXT UNIQUE,     -- e.g., "gpt-4o"
  display_name TEXT,              -- e.g., "GPT-4 Omni"
  family TEXT,                    -- e.g., "gpt-4"
  vendor TEXT,                    -- e.g., "openai"
  context_window INTEGER,
  speed_tier TEXT,                -- FAST, MEDIUM, SLOW
  quality_tier TEXT,              -- STANDARD, HIGH, PREMIUM
  suitable_for_tasks TEXT[],      -- ["CHAT", "COMPLEX", "TOOL_CALLING"]
  capabilities TEXT[]             -- ["vision", "function_calling"]
);

-- Provider mappings (same model, different providers)
CREATE TABLE ai_model_provider_mapping (
  id TEXT PRIMARY KEY,
  model_id TEXT REFERENCES ai_model(id),
  provider TEXT,                  -- OPENAI_DIRECT, VERCEL_GATEWAY, GROQ, etc.
  provider_model_id TEXT,         -- Provider-specific identifier
  priority INTEGER DEFAULT 0
);

-- System defaults by task type
CREATE TABLE ai_task_model_default (
  id TEXT PRIMARY KEY,
  task_type TEXT,                 -- SIMPLE, COMPLEX, REASONING, CHAT, etc.
  complexity TEXT,                -- SIMPLE, MEDIUM, COMPLEX
  model_id TEXT REFERENCES ai_model(id)
);

-- User preferences
CREATE TABLE user_model_preference (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  task_type TEXT,
  agent_id TEXT,                  -- Optional: specific agent override
  model_id TEXT REFERENCES ai_model(id),
  override_provider TEXT          -- Force specific provider mapping
);

-- Organization preferences
CREATE TABLE organization_model_preference (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  task_type TEXT,
  agent_id TEXT,
  model_id TEXT REFERENCES ai_model(id),
  override_provider TEXT,
  enforce_for_members BOOLEAN     -- If true, users cannot override
);

-- User provider configuration
CREATE TABLE user_cloud_provider_config (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  provider TEXT,                  -- VERCEL_GATEWAY, OPENAI_DIRECT, etc.
  is_default BOOLEAN,
  enabled BOOLEAN,
  config JSONB                    -- { apiKey, baseUrl, enabledProviders }
);

-- Organization provider configuration
CREATE TABLE cloud_provider_config (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  provider TEXT,
  is_default BOOLEAN,
  enabled BOOLEAN,
  config JSONB
);
```

---

## Related Files

| File | Purpose |
|------|---------|
| **`packages/database/prisma/ai-model-catalog.ts`** | **SINGLE SOURCE OF TRUTH: All model definitions, provider mappings, and defaults** |
| `packages/database/prisma/seed-ai-models.ts` | Seeds the catalog data into database tables |
| `packages/database/__tests__/ai-model-validation.test.ts` | Validates model names per provider |
| `apps/web/app/api/copilotkit/route.ts` | CopilotKit runtime, agent provider override logic |
| `packages/agent-core/src/unified-server.ts` | Agent server, ai_api_key priority handling |
| `packages/agent-core/src/services/langchain-models.ts` | LangChain model factory, extractProviderConfig |
| `packages/agent-core/src/services/token-exchange.ts` | Token exchange client for agents |
| `packages/ai/index.ts` | Model instantiation, gateway routing |
| `packages/ai/lib/dynamic-model-selector.ts` | Database-driven model selection |
| `packages/database/prisma/queries/ai-models.ts` | Preference queries, getUserModelPreference |
| `packages/database/prisma/queries/ai-gateway.ts` | Provider config queries |
| `packages/agent-core/src/services/ai-gateway.ts` | High-level API resolution |
| `packages/temporal/src/activities/orchestrator/utils/model-selector.ts` | Temporal integration |
| `packages/fabric-ai/client.ts` | Fabric AI client with catalog defaults |
| `packages/fabric-ai/full-executor.ts` | Fabric AI full mode execution |
| `packages/mcp/lib/sampling.ts` | MCP sampling model selection |
| `apps/web/app/api/ai/keys/exchange/route.ts` | Token exchange endpoint (default provider only) |
| `apps/web/app/api/agents/ai-config/task/route.ts` | Task-specific AI config API |

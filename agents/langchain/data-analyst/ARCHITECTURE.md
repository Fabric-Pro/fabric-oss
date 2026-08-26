# Data Analyst Agent - Architecture Documentation

## Project Summary

**Data Analyst Agent** is a multi-framework AI-powered data analysis application built with Next.js 16. It allows users to analyze data from multiple sources (HubSpot, Attio, Google Sheets) through natural language conversations. 

The unique aspect of this project is that it supports **four different AI frameworks** (Vercel AI SDK, LangChain, OpenAI Agents SDK, and Claude Agents SDK) that all integrate with **Composio's Tool Router** for unified tool access.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: NextAuth.js v5 (Auth.js)
- **AI Frameworks**:
  - Vercel AI SDK (with MCP support)
  - LangChain (with MultiServerMCPClient)
  - OpenAI Agents SDK
  - Claude Agents SDK
- **Tool Integration**: Composio Tool Router (MCP Server)
- **AI Providers**: OpenAI (GPT-4o, GPT-4o Mini), Anthropic (Claude Opus/Sonnet/Haiku), Google (Gemini)
- **Styling**: Tailwind CSS
- **Validation**: Zod
- **Testing**: Vitest

## High-Level Architecture

```mermaid
graph TB
    subgraph "Frontend Layer"
        UI[Next.js UI<br/>React Components]
        Input[Chat Input<br/>Framework & Model Selector]
    end
    
    subgraph "API Layer"
        Route["/api/chat Route Handler"]
        Auth[NextAuth v5<br/>Authentication]
        RateLimit[Rate Limiter<br/>10 req/min]
    end
    
    subgraph "Framework Router"
        Router{Framework<br/>Selection}
        VercelSDK[Vercel AI SDK<br/>streamText + MCP]
        LangChain[LangChain<br/>React Agent + MCP]
        OpenAIAgents[OpenAI Agents SDK<br/>hostedMcpTool]
        ClaudeAgents[Claude Agents SDK<br/>HTTP MCP]
    end
    
    subgraph "Tool Integration"
        Composio[Composio Tool Router<br/>MCP Server]
        Tools[External Tools<br/>HubSpot, Attio, Sheets]
    end
    
    subgraph "AI Providers"
        OpenAI[OpenAI<br/>GPT-4o, GPT-4o Mini]
        Anthropic[Anthropic<br/>Claude Opus/Sonnet/Haiku]
        Google[Google<br/>Gemini Models]
    end
    
    subgraph "Data Layer"
        DB[(PostgreSQL<br/>Drizzle ORM)]
        ChatHistory[Chat History<br/>Messages & Sessions]
    end
    
    UI --> Input
    Input --> Route
    Route --> Auth
    Auth --> RateLimit
    RateLimit --> Router
    
    Router -->|ai-sdk| VercelSDK
    Router -->|langchain| LangChain
    Router -->|openai-agents| OpenAIAgents
    Router -->|claude-agents| ClaudeAgents
    
    VercelSDK --> Composio
    LangChain --> Composio
    OpenAIAgents --> Composio
    ClaudeAgents --> Composio
    
    Composio --> Tools
    
    VercelSDK -.->|API Calls| OpenAI
    VercelSDK -.->|API Calls| Anthropic
    VercelSDK -.->|API Calls| Google
    
    LangChain -.->|API Calls| OpenAI
    LangChain -.->|API Calls| Anthropic
    
    OpenAIAgents -.->|API Calls| OpenAI
    ClaudeAgents -.->|API Calls| Anthropic
    
    Route --> DB
    DB --> ChatHistory
    
    style Router fill:#4f46e5,stroke:#4338ca,color:#fff
    style Composio fill:#f97316,stroke:#ea580c,color:#fff
    style UI fill:#06b6d4,stroke:#0891b2,color:#fff
    style DB fill:#10b981,stroke:#059669,color:#fff
```

## Request Flow - How Frameworks Work Together

```mermaid
sequenceDiagram
    participant User
    participant UI as Next.js UI
    participant API as /api/chat
    participant Router as Framework Router
    participant Vercel as Vercel AI SDK
    participant LC as LangChain
    participant OAI as OpenAI Agents
    participant Claude as Claude Agents
    participant MCP as Composio MCP
    participant LLM as AI Provider
    participant DB as PostgreSQL
    
    User->>UI: Select Framework & Model
    User->>UI: Send Message
    UI->>API: POST /api/chat<br/>{framework, model, messages}
    
    API->>API: Authenticate (NextAuth)
    API->>API: Check Rate Limit
    API->>API: Get Composio MCP Session
    
    API->>Router: Route based on framework
    
    alt Framework: ai-sdk (Default)
        Router->>Vercel: handleVercelAI()
        Vercel->>MCP: createMCPClient(http)
        MCP-->>Vercel: Return tools
        Vercel->>LLM: streamText(model, messages, tools)
        LLM->>MCP: Execute tool calls
        MCP-->>LLM: Tool results
        LLM-->>Vercel: Stream response
        Vercel-->>API: ReadableStream
    else Framework: langchain
        Router->>LC: handleLangchain()
        LC->>MCP: MultiServerMCPClient
        MCP-->>LC: Return tools
        LC->>LC: createReactAgent(llm, tools)
        LC->>LLM: Agent.stream(messages)
        LLM->>MCP: Execute tool calls
        MCP-->>LLM: Tool results
        LLM-->>LC: Stream response
        LC-->>API: ReadableStream
    else Framework: openai-agents
        Router->>OAI: handleOpenAIAgents()
        OAI->>OAI: Create Agent with hostedMcpTool
        OAI->>LLM: run(agent, message)
        LLM->>MCP: Execute tool calls via MCP
        MCP-->>LLM: Tool results
        LLM-->>OAI: Response
        OAI-->>API: ReadableStream
    else Framework: claude-agents
        Router->>Claude: handleClaudeAgents()
        Claude->>Claude: Create Agent with MCP config
        Claude->>LLM: Agent.run(prompt)
        LLM->>MCP: Execute tool calls via HTTP
        MCP-->>LLM: Tool results
        LLM-->>Claude: Stream response
        Claude-->>API: ReadableStream
    end

    API->>DB: Save messages to chat history
    API-->>UI: Stream response
    UI-->>User: Display messages & tool results

    Note over Router,MCP: All frameworks use Composio MCP<br/>for unified tool access
```

## Framework Integration Details

```mermaid
graph LR
    subgraph "Framework Handlers"
        direction TB
        V[Vercel AI SDK<br/>lib/frameworks/vercel]
        L[LangChain<br/>lib/frameworks/langchain.ts]
        O[OpenAI Agents<br/>lib/frameworks/openai-agents.ts]
        C[Claude Agents<br/>lib/frameworks/claude-agents.ts]
    end

    subgraph "Vercel AI SDK Flow"
        V1[createMCPClient]
        V2[client.tools]
        V3[streamText with tools]
        V1 --> V2 --> V3
    end

    subgraph "LangChain Flow"
        L1[MultiServerMCPClient]
        L2[client.getTools]
        L3[createReactAgent]
        L4[agent.stream]
        L1 --> L2 --> L3 --> L4
    end

    subgraph "OpenAI Agents Flow"
        O1[hostedMcpTool config]
        O2[new Agent with tools]
        O3[run with MemorySession]
        O1 --> O2 --> O3
    end

    subgraph "Claude Agents Flow"
        C1[MCP HTTP config]
        C2[Agent with mcpServers]
        C3[agent.run with prompt]
        C1 --> C2 --> C3
    end

    subgraph "Composio MCP Server"
        MCP[HTTP MCP Endpoint]
        T1[HubSpot Tools]
        T2[Attio Tools]
        T3[Google Sheets Tools]
        T4[Other Integrations]
        MCP --> T1
        MCP --> T2
        MCP --> T3
        MCP --> T4
    end

    V --> V1
    L --> L1
    O --> O1
    C --> C1

    V3 -.->|HTTP| MCP
    L4 -.->|HTTP| MCP
    O3 -.->|HTTP| MCP
    C3 -.->|HTTP| MCP

    style V fill:#000,stroke:#fff,color:#fff
    style L fill:#1c3c3c,stroke:#fff,color:#fff
    style O fill:#10a37f,stroke:#fff,color:#fff
    style C fill:#d97757,stroke:#fff,color:#fff
    style MCP fill:#f97316,stroke:#ea580c,color:#fff
```

## Authentication & Data Flow

```mermaid
sequenceDiagram
    participant User
    participant Login as Login Page
    participant Composio as Composio Auth
    participant Callback as /auth/callback
    participant NextAuth as NextAuth v5
    participant DB as PostgreSQL
    participant Chat as Chat Interface

    User->>Login: Click "Sign in with Composio"
    Login->>Login: Generate unique userId (nanoid)
    Login->>Composio: POST /api/v1/auth/link<br/>{userId, authConfigId}
    Composio-->>Login: Return auth URL
    Login->>User: Redirect to Composio

    User->>Composio: Authenticate with provider<br/>(Google/GitHub)
    Composio->>Callback: Redirect with userId

    Callback->>Callback: Verify userId exists
    Callback->>NextAuth: signIn("credentials", {userId})
    NextAuth->>DB: Store session via DrizzleAdapter
    NextAuth-->>Callback: Create JWT session
    Callback->>User: Redirect to /

    User->>Chat: Access chat interface
    Chat->>NextAuth: Check session
    NextAuth-->>Chat: Return user session

    User->>Chat: Send message
    Chat->>NextAuth: Verify auth
    NextAuth-->>Chat: userId from JWT
    Chat->>Composio: Get tool session for userId
    Composio-->>Chat: MCP URL + headers
    Chat->>Chat: Execute with selected framework
    Chat->>DB: Save chat history

    Note over Login,Composio: Composio handles OAuth<br/>with external providers
    Note over NextAuth,DB: NextAuth manages sessions<br/>with Drizzle ORM
```

## Key Architecture Insights

### 1. Unified Tool Access via Composio MCP

All four frameworks (Vercel AI SDK, LangChain, OpenAI Agents, Claude Agents) connect to the **same Composio MCP (Model Context Protocol) server**. This is the key architectural decision that enables framework flexibility.

**How it works:**
- Composio acts as a **universal tool router** that provides access to external integrations (HubSpot, Attio, Google Sheets)
- Each framework has its own MCP client implementation, but they all hit the same HTTP endpoint
- The MCP server exposes tools in a standardized format that all frameworks can consume
- Tool execution happens server-side through Composio, ensuring consistent behavior

### 2. Framework-Specific Implementations

Each framework has a dedicated handler in `lib/frameworks/`:

#### **Vercel AI SDK** (Default - `lib/frameworks/vercel`)
- **Implementation**: Uses `createMCPClient` and `streamText`
- **Strengths**: Most flexible, supports all models (OpenAI, Anthropic, Google)
- **Use Case**: General-purpose, production-ready streaming
- **File**: Implemented directly in `/app/api/chat/route.ts`

#### **LangChain** (`lib/frameworks/langchain.ts`)
- **Implementation**: Uses `MultiServerMCPClient` with React Agent pattern
- **Strengths**: Complex reasoning chains, agent patterns, extensive ecosystem
- **Use Case**: Multi-step reasoning, complex workflows
- **Models**: Supports OpenAI and Anthropic models

#### **OpenAI Agents SDK** (`lib/frameworks/openai-agents.ts`)
- **Implementation**: Uses `hostedMcpTool` with native OpenAI Agent
- **Strengths**: Native OpenAI integration, optimized for GPT models
- **Use Case**: GPT-specific features, OpenAI ecosystem
- **Models**: GPT models only (auto-switches if incompatible model selected)

#### **Claude Agents SDK** (`lib/frameworks/claude-agents.ts`)
- **Implementation**: Uses HTTP MCP config with Anthropic's Agent SDK
- **Strengths**: Native Anthropic integration, Claude-specific features
- **Use Case**: Claude-specific optimizations, Anthropic ecosystem
- **Models**: Claude models only

### 3. Single Entry Point with Dynamic Routing

The `/app/api/chat/route.ts` acts as a **framework router**:

```typescript
// Simplified routing logic
if (framework === "langchain") {
  return handleLangchain(context);
} else if (framework === "openai-agents") {
  return handleOpenAIAgents(context);
} else if (framework === "claude-agents") {
  return handleClaudeAgents(context);
} else {
  // Default: Vercel AI SDK
  return handleVercelAI(context);
}
```

**Key features:**
- All handlers receive the same context (messages, model, MCP config)
- All handlers return a `ReadableStream` for consistent streaming responses
- Rate limiting (10 req/min) applied before routing
- Authentication verified before any framework execution

### 4. Model Compatibility Layer

The system includes automatic model compatibility checking:

```typescript
function getCompatibleModel(framework: string, requestedModel: string): string {
  // Auto-switches to compatible model if mismatch detected
  // Example: OpenAI Agents + Claude model → switches to GPT-4o
}
```

This ensures users can't accidentally select incompatible framework/model combinations.

### 5. Shared Infrastructure

All frameworks share common infrastructure:

#### **Authentication (NextAuth v5)**
- Composio OAuth integration for external providers
- JWT-based sessions stored in PostgreSQL
- Middleware protection for all routes
- Session verification on every API call

#### **Database (PostgreSQL + Drizzle ORM)**
- Unified chat history across all frameworks
- Messages stored with full context (text, tool calls, images)
- Session management via DrizzleAdapter
- Efficient querying with Drizzle's type-safe API

#### **Rate Limiting**
- In-memory rate limiter (10 requests per minute per user)
- Applied uniformly across all frameworks
- Prevents abuse and manages API costs

#### **Tool Integration (Composio MCP)**
- Single MCP session per user
- Tools available to all frameworks simultaneously
- Consistent tool execution regardless of framework
- HTTP-based MCP transport for reliability

## Why Multiple Frameworks?

This architecture demonstrates **framework flexibility** and provides several benefits:

### **1. Performance Comparison**
Users can compare the same query across different frameworks to see which performs better for their specific use case.

### **2. Framework-Specific Features**
- **LangChain**: Access to agent patterns, memory systems, and complex chains
- **OpenAI Agents**: Native GPT optimizations and OpenAI-specific features
- **Claude Agents**: Anthropic's latest agent capabilities
- **Vercel AI SDK**: Cutting-edge streaming and multi-modal support

### **3. Vendor Independence**
The application isn't locked into a single framework. If one framework has issues or becomes deprecated, others can be used as fallbacks.

### **4. Learning & Experimentation**
Developers can learn different AI framework patterns and experiment with various approaches to the same problem.

### **5. Future-Proofing**
New frameworks can be added easily by:
1. Creating a new handler in `lib/frameworks/`
2. Adding the framework to the router in `/app/api/chat/route.ts`
3. Updating the UI selector in `lib/constants.ts`

## File Structure

```
data-analyst-agent/
├── app/
│   ├── api/
│   │   └── chat/
│   │       └── route.ts          # Main framework router & API endpoint
│   ├── auth/
│   │   └── callback/             # OAuth callback handler
│   ├── login/                    # Login page
│   └── page.tsx                  # Main chat interface
├── lib/
│   ├── frameworks/
│   │   ├── langchain.ts          # LangChain implementation
│   │   ├── openai-agents.ts      # OpenAI Agents implementation
│   │   └── claude-agents.ts      # Claude Agents implementation
│   ├── db/                       # Database schema & client
│   ├── auth.ts                   # NextAuth configuration
│   ├── auth.config.ts            # Auth config
│   └── constants.ts              # Framework & model definitions
├── components/
│   ├── chat/
│   │   ├── chat-input.tsx        # Framework & model selector
│   │   ├── chat-message.tsx      # Message rendering
│   │   └── chat-sidebar.tsx      # Chat history sidebar
│   └── ui/                       # Reusable UI components
└── hooks/
    ├── use-chat-history.ts       # Chat history management
    └── use-streaming-chat.ts     # Streaming chat hook
```

## Key Takeaways

1. **Composio MCP is the unifying layer** - It provides a standardized interface that all frameworks can consume
2. **Framework handlers are interchangeable** - They all implement the same contract (input context → output stream)
3. **User experience is consistent** - Regardless of framework choice, the UI and data flow remain the same
4. **Tool integration is framework-agnostic** - Tools work identically across all frameworks
5. **The architecture is extensible** - New frameworks can be added without modifying existing code

This design pattern demonstrates how to build **framework-agnostic AI applications** that can adapt to the rapidly evolving AI ecosystem.


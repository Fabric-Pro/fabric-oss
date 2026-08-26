<div align="center">

# Data Analyst Agent

</div>

A stateless Data Analyst AI Agent with multi-framework support, powered by Fabric Tool Router for MCP tool integration. Built for connecting to multiple data sources like Hubspot, Attio, Google Sheets and analyzing data, generating insights, and creating visualizations through natural language conversations.

## Features

- **Multi-Framework Support**: Choose from Vercel AI SDK, LangChain, OpenAI Agents SDK, or Claude Agents SDK
- **Multi-Model Support**: Works with OpenAI (GPT-4o, GPT-4o Mini), Anthropic (Claude Opus 4.5, Sonnet 4.5, Haiku 4.5), and Google models
- **Tool Integration**: Seamless integration with external tools via Fabric Tool Router (MCP)
- **Authentication**: Secure authentication flow via Fabric's Better Auth
- **Stateless Architecture**: No local database required - designed for container deployment
- **Modern UI**: Beautiful chat interface with dark mode, live previews, and responsive design
- **Rate Limiting**: Built-in rate limiting for API protection
- **Security**: Request validation, environment validation, and secure auth flows

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Server**: Hono (for unified-server.ts deployment)
- **Auth**: Fabric Better Auth (via fabric-auth.ts)
- **AI Frameworks**:
  - Vercel AI SDK (with MCP support)
  - LangChain (with MultiServerMCPClient)
  - OpenAI Agents SDK
  - Claude Agents SDK
- **Tool Integration**: Fabric Tool Router (MCP)
- **Styling**: Tailwind CSS
- **Validation**: Zod
- **Testing**: Vitest

## Getting Started

### 1. Prerequisites

- Node.js 18+
- Fabric Portal running (provides auth and MCP tools)

### 2. Environment Setup

Create a `.env` file in the root directory:

```bash
# Fabric API (REQUIRED)
FABRIC_API_URL="http://localhost:3001"
AGENT_API_KEY="your_agent_api_key"  # From Fabric settings or Key Vault
```

**Note:** AI provider keys are provided via token exchange at runtime from Fabric's AI configuration.

### 3. Installation

```bash
pnpm install
```

### 4. Run Development Server

For the standalone Hono server (what gets deployed):

```bash
pnpm dev:server
```

For local Next.js development with UI:

```bash
pnpm dev
```

For both simultaneously:

```bash
pnpm dev:all
```

## Architecture

### Stateless Design

This agent is designed to be stateless for container deployment:
- No local database - chat history is managed by the Fabric portal
- Authentication via Fabric's Better Auth system
- Tools accessed through Fabric Tool Router (centralized MCP management)

### Authentication Flow

1. User authenticates via Fabric portal
2. Requests include Fabric session token
3. Agent validates token with Fabric API
4. Tool access is scoped to user/organization context

### AI & Tools

The application supports four different AI frameworks:

1. **Vercel AI SDK** (default): Uses `streamText` with MCP client for tool integration
2. **LangChain**: Uses `MultiServerMCPClient` with React Agent
3. **OpenAI Agents SDK**: Native OpenAI agent framework
4. **Claude Agents SDK**: Native Anthropic agent framework

Tools are executed via Fabric's MCP Tool Router. The system automatically routes to the appropriate framework handler based on your selection. Rate limiting (10 requests per minute) is applied per user session.

### Fabric Tool Router Integration

The agent connects to Fabric's tool router to access MCP tools:

```typescript
const toolSession = await getFabricToolSession(userId, organizationId);
// toolSession.mcp.url - MCP endpoint URL
// toolSession.mcp.headers - Auth headers for MCP requests
```

## Deployment

### Azure Container Apps

The agent is deployed as a stateless container:

1. Build the Docker image using the provided `Dockerfile`
2. Set environment variables in Azure Container Apps:
   - `FABRIC_API_URL` - URL of your Fabric portal
   - `AGENT_API_KEY` - API key for agent authentication
3. The container listens on port 8130 by default

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `FABRIC_API_URL` | Fabric portal URL |
| `AGENT_API_KEY` | Agent authentication key |

## Available Scripts

- `pnpm dev`: Start Next.js development server (port 3002)
- `pnpm dev:server`: Start Hono server (port 8130)
- `pnpm dev:all`: Start both servers concurrently
- `pnpm build`: Build for production (Next.js + unified-server)
- `pnpm start`: Start Next.js production server
- `pnpm start:server`: Start Hono production server
- `pnpm lint`: Run ESLint
- `pnpm format`: Format code with Prettier
- `pnpm test`: Run tests with Vitest
- `pnpm test:watch`: Run tests in watch mode

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

---

## Fabric Integration

This agent is part of the Fabric ecosystem and uses:

- **Fabric Tool Router**: Centralized MCP tool management
- **Fabric Better Auth**: Authentication and authorization
- **Fabric AI Config**: Model and provider configuration

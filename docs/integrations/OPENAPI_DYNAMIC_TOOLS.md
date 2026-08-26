# OpenAPI Dynamic Tool Loading

This document describes the OpenAPI Dynamic Tool Loading feature, which allows you to automatically generate agent tools from OpenAPI 3.x specifications.

## Overview

OpenAPI Dynamic Tool Loading enables you to:
- Connect external APIs by providing their OpenAPI specification URL
- Automatically parse and extract tool definitions from the spec
- Configure authentication (API Key, Bearer Token, Basic Auth, OAuth2)
- Enable/disable individual tools
- Test tools before binding them to agents
- Load tools at runtime for LangGraph agents

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OpenAPI Spec   │────▶│  Parser Package  │────▶│  Database       │
│  (JSON/YAML)    │     │  @repo/openapi-  │     │  OpenAPIService │
│                 │     │  tools           │     │  OpenAPITool    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  LangGraph      │◀────│  Tool Loader     │◀────│  API Endpoints  │
│  Agent          │     │  (Runtime)       │     │  /openapi/*     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Database Schema

### OpenAPIService
Stores API service configurations with multi-tenancy support.

| Field | Type | Description |
|-------|------|-------------|
| id | String | Unique identifier |
| name | String | Service display name |
| description | String? | Optional description |
| specUrl | String | URL to OpenAPI spec |
| baseUrl | String? | Override base URL |
| status | Enum | ACTIVE, INACTIVE, ERROR, SYNCING |
| authType | Enum | NONE, API_KEY, BEARER, BASIC, OAUTH2 |
| authKey | String? | Header name for API key |
| authValue | String? | Encrypted auth value |
| authLocation | Enum | HEADER, QUERY, COOKIE |
| userId | String? | Owner user (personal) |
| organizationId | String? | Owner organization |
| createdById | String | User who created |

### OpenAPITool
Individual tools parsed from OpenAPI specs.

| Field | Type | Description |
|-------|------|-------------|
| id | String | Unique identifier |
| serviceId | String | Parent service |
| name | String | Tool name (operationId) |
| description | String? | Tool description |
| method | String | HTTP method |
| path | String | API path |
| enabled | Boolean | Whether tool is active |
| parametersSchema | Json | Zod-compatible params |
| requestBodySchema | Json? | Request body schema |
| responseSchema | Json? | Response schema |

## API Endpoints

### Services

```typescript
// List services
GET /api/openapi/services/list
Input: { organizationId?: string }
Output: OpenAPIService[]

// Onboard new service
POST /api/openapi/services/onboard
Input: {
  specUrl: string;
  name: string;
  organizationId?: string;
  authType?: "NONE" | "API_KEY" | "BEARER" | "BASIC" | "OAUTH2";
  authKey?: string;
  authValue?: string;
  authLocation?: "HEADER" | "QUERY" | "COOKIE";
}
Output: OpenAPIService

// Sync service (re-parse spec)
POST /api/openapi/services/sync
Input: { id: string; organizationId?: string }
Output: OpenAPIService

// Delete service
DELETE /api/openapi/services/delete
Input: { id: string; organizationId?: string }
Output: { success: boolean }
```

### Tools

```typescript
// List tools for a service
GET /api/openapi/tools/listForService
Input: { serviceId: string; organizationId?: string }
Output: OpenAPITool[]

// Enable/disable tool
POST /api/openapi/tools/setEnabled
Input: { id: string; enabled: boolean; organizationId?: string }
Output: OpenAPITool

// Execute tool (for testing)
POST /api/openapi/tools/execute
Input: { toolId: string; parameters: Record<string, unknown>; organizationId?: string }
Output: { success: boolean; data?: unknown; error?: string }

// Load tools for agent runtime
GET /api/openapi/tools/loadForAgent
Input: { organizationId?: string; serviceIds?: string[] }
Output: { tools: LangChainTool[]; errors: string[] }
```

## Usage

### Adding a Service (UI)

1. Navigate to **Settings > OpenAPI Services** (personal or organization)
2. Click **Add Service**
3. Enter the OpenAPI spec URL (e.g., `https://api.example.com/openapi.json`)
4. Configure authentication if required
5. Click **Add Service**

The system will:
- Fetch and parse the OpenAPI specification
- Extract all operations as tools
- Store them in the database
- Enable all tools by default

### Configuring Tools

1. Click the **Configure** (gear) icon on a service
2. Toggle individual tools on/off
3. Click **Test** (play) icon to test a tool
4. Enter parameters and execute


## Package Structure

### @repo/openapi-tools

Located at `packages/openapi-tools/`:

```
packages/openapi-tools/
├── src/
│   ├── index.ts          # Main exports
│   ├── types.ts          # Type definitions
│   └── lib/
│       ├── parser.ts     # OpenAPI spec parser
│       ├── executor.ts   # Tool execution engine
│       └── loader.ts     # LangChain tool converter
└── package.json
```

### Parser (`parser.ts`)

Parses OpenAPI 3.x specifications and extracts tool definitions:

```typescript
import { parseOpenAPISpec } from "@repo/openapi-tools";

const result = await parseOpenAPISpec("https://api.example.com/openapi.json");
// Returns: { tools: ParsedOpenAPITool[], errors: string[] }
```

### Executor (`executor.ts`)

Executes tools with proper authentication:

```typescript
import { executeOpenAPITool } from "@repo/openapi-tools";

const result = await executeOpenAPITool(tool, {
  baseUrl: "https://api.example.com",
  authType: "API_KEY",
  authKey: "X-API-Key",
  authValue: "secret",
  authLocation: "HEADER",
}, parameters);
```

### Loader (`loader.ts`)

Converts database records to LangChain-compatible tools:

```typescript
import { createOpenAPIAgentTool, toLangChainTool } from "@repo/openapi-tools";

const agentTool = createOpenAPIAgentTool(parsedTool, config);
const langChainTool = toLangChainTool(agentTool);
```

## Authentication Types

| Type | Description | Required Fields |
|------|-------------|-----------------|
| NONE | No authentication | - |
| API_KEY | API key in header/query | authKey, authValue, authLocation |
| BEARER | Bearer token | authValue |
| BASIC | Basic auth | authValue (base64 encoded) |
| OAUTH2 | OAuth 2.0 | oauth2AuthUrl, oauth2TokenUrl, oauth2ClientId, oauth2ClientSecret |

## Multi-Tenancy

OpenAPI services support full multi-tenancy:

- **Personal Services**: Set `userId`, leave `organizationId` null
- **Organization Services**: Set `organizationId`, leave `userId` null

All queries filter by the appropriate tenant context automatically.

## Error Handling

The system handles various error scenarios:

1. **Invalid Spec URL**: Returns error if spec cannot be fetched
2. **Parse Errors**: Returns partial results with error messages
3. **Auth Failures**: Returns 401/403 with clear error messages
4. **Execution Errors**: Captures and returns API error responses

## Best Practices

1. **Use HTTPS**: Always use HTTPS URLs for OpenAPI specs
2. **Secure Credentials**: Auth values are stored encrypted
3. **Test Before Binding**: Use the test playground before enabling tools
4. **Monitor Sync Status**: Check service status after syncing
5. **Limit Tool Scope**: Disable tools you don't need to reduce attack surface

## Troubleshooting

### Service shows "Error" status

1. Check the error message in the tooltip
2. Verify the spec URL is accessible
3. Ensure the spec is valid OpenAPI 3.x
4. Check authentication credentials

### Tools not appearing

1. Sync the service to refresh tools
2. Check if tools are enabled
3. Verify the spec contains operations

### Tool execution fails

1. Test the tool in the playground
2. Check authentication configuration
3. Verify required parameters are provided
4. Check the API server is accessible

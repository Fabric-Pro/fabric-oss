# Agent Security Guide

This guide explains how to secure inter-agent communication in the Fabric platform using the multi-tenant security framework.

## Overview

The security framework provides:

1. **Service Token Authentication** - Proves requests are from trusted internal services
2. **Signed Tenant Context** - HMAC-signed user/organization context
3. **Replay Attack Prevention** - Timestamp validation
4. **Multi-Tenant Isolation** - Each request carries explicit tenant identity

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Security Headers                                │
├─────────────────────────────────────────────────────────────────────────┤
│ X-Service-Token:     Shared secret between orchestrator and agents      │
│ X-Tenant-Payload:    Base64({userId, orgId, scopes, timestamp})         │
│ X-Tenant-Signature:  HMAC-SHA256(payload, secret)                       │
│ X-Tenant-Timestamp:  Unix timestamp (ms) when signed                    │
│ X-Source-Agent:      Calling agent ID (for tracing)                     │
│ X-Request-ID:        Request correlation ID                             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Set Environment Variable

All agents and the orchestrator must share the same secret:

```bash
# In .env or production environment variables
AGENT_SERVICE_SECRET=your-secret-key-at-least-32-chars-long
```

### 2. Apply Security to Your Agent

```typescript
import { Hono } from "hono";
import { applySecurity, validateSecurityConfig } from "@repo/agent-runtime";

const app = new Hono();

// Validate security config at startup
const securityCheck = validateSecurityConfig();
if (!securityCheck.valid) {
  console.error("Security misconfigured:", securityCheck.errors);
  process.exit(1);
}

// Apply all security middleware
applySecurity(app, {
  // Paths that don't require authentication
  skipPaths: ["/health", "/.well-known/agent.json"],
});

// Your routes - tenant context is available
app.post("/a2a/send", async (c) => {
  const tenant = c.get("tenant");
  console.log(`Request from user: ${tenant.userId}, org: ${tenant.organizationId}`);
  
  // Use tenant for authorization, audit logging, etc.
  // Model resolution happens inside the LangGraph nodes via
  // getAgentModelAsync(config, { taskType }) from "@repo/agent-core".
  // ...
});
```

### 3. Manual Middleware (Advanced)

For more control, apply middleware individually:

```typescript
import { Hono } from "hono";
import { 
  serviceAuth, 
  requestContext, 
  agentErrorHandler 
} from "@repo/agent-runtime";

const app = new Hono();

// Request context (timing, request ID)
app.use("*", requestContext({ agentId: "my-agent" }));

// Service authentication (validates token + tenant)
app.use("*", serviceAuth({
  skipPaths: ["/health", "/.well-known/agent.json"],
  maxContextAge: 5 * 60 * 1000, // 5 minutes
  requireTenantContext: true,
}));

// Error handling
app.onError(agentErrorHandler());
```

## Security Properties

### What's Protected

| Threat | Protection |
|--------|------------|
| Unauthorized access | Service token required |
| Tenant impersonation | HMAC signature verification |
| Replay attacks | Timestamp validation (5 min default) |
| Timing attacks | Constant-time comparisons |

### What's NOT Protected

- **DDoS**: Use your cloud provider's rate limiting or add your own
- **mTLS**: Not implemented (use private networking in your cloud provider)
- **Request encryption**: Use HTTPS in production

## Using Tenant Context

Once authenticated, access tenant information:

```typescript
app.post("/a2a/send", async (c) => {
  // Get verified tenant context
  const tenant = c.get("tenant");
  
  // Available fields
  tenant.userId;         // string - User ID
  tenant.organizationId; // string | null - Organization ID
  tenant.scopes;         // string[] | undefined - Permission scopes
  tenant.apiKeyId;       // string | undefined - API key used
  
  // Model resolution happens in the LangGraph nodes via
  // getAgentModelAsync(config, { taskType }) from "@repo/agent-core";
  // the tenant context here is for authorization + audit logging.
  console.log(`[Audit] User ${tenant.userId} invoked agent`);
});
```

## Orchestrator Integration

The orchestrator uses `SecureA2AClient` to pass tenant context:

```typescript
import { SecureA2AClient } from "@repo/agent-core";

const client = new SecureA2AClient({
  sourceAgent: "orchestrator",
  timeout: 120000,
});

// Tenant context is automatically signed and sent
const task = await client.sendMessageSecure(
  agentUrl,
  message,
  { userId: "user_123", organizationId: "org_456" }
);
```

## Troubleshooting

### "AGENT_SERVICE_SECRET not set"

Set the environment variable in all services:
```bash
export AGENT_SERVICE_SECRET="your-32-char-minimum-secret"
```

### "Invalid signature"

- Ensure all services use the same `AGENT_SERVICE_SECRET`
- Check for clock skew between services (>5 min difference)

### "Tenant context expired"

- Default max age is 5 minutes
- Increase with `maxContextAge` option if needed
- Check for significant clock differences

## Best Practices

1. **Generate a strong secret**: Use `openssl rand -hex 32`
2. **Rotate secrets periodically**: Update all services together
3. **Use private networking**: Agents shouldn't be publicly accessible
4. **Log security events**: Enable `logSecurityEvents: true`
5. **Validate at startup**: Use `validateSecurityConfig()` to fail fast


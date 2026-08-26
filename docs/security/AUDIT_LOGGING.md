# Audit Logging Guide

This guide covers the audit logging system in Fabric for security compliance and monitoring.

## Overview

The audit logging system provides:
- **Structured event logging** for security-relevant actions
- **Multiple severity levels** for filtering and alerting
- **Correlation ID integration** for request tracing
- **External webhook support** for SIEM integration
- **Type-safe event definitions** for consistency

## Event Categories

### Authentication Events

Track user authentication lifecycle:

| Event | Severity | Description |
|-------|----------|-------------|
| `AUTH_LOGIN_SUCCESS` | info | Successful login |
| `AUTH_LOGIN_FAILED` | warning | Failed login attempt |
| `AUTH_LOGOUT` | info | User logout |
| `AUTH_SESSION_EXPIRED` | info | Session timeout |
| `AUTH_PASSWORD_CHANGED` | info | Password update |
| `AUTH_MFA_ENABLED` | info | MFA activated |
| `AUTH_MFA_DISABLED` | warning | MFA deactivated |
| `AUTH_API_KEY_CREATED` | info | New API key created |
| `AUTH_API_KEY_REVOKED` | warning | API key revoked |

### Authorization Events

Track access control decisions:

| Event | Severity | Description |
|-------|----------|-------------|
| `AUTHZ_ACCESS_GRANTED` | info | Access allowed |
| `AUTHZ_ACCESS_DENIED` | warning | Access blocked |
| `AUTHZ_PERMISSION_CHANGED` | warning | Permission modified |
| `AUTHZ_ROLE_CHANGED` | warning | Role assignment changed |

### Security Events

Track security incidents:

| Event | Severity | Description |
|-------|----------|-------------|
| `SECURITY_RATE_LIMIT_EXCEEDED` | warning | Rate limit hit |
| `SECURITY_SUSPICIOUS_ACTIVITY` | error | Anomaly detected |
| `SECURITY_BRUTE_FORCE_DETECTED` | error | Multiple failed attempts |
| `SECURITY_SSRF_BLOCKED` | error | SSRF attempt blocked |
| `SECURITY_INJECTION_BLOCKED` | error | Injection attempt blocked |
| `SECURITY_INVALID_TOKEN` | warning | Invalid auth token |

### Data Operation Events

Track data access and modifications:

| Event | Severity | Description |
|-------|----------|-------------|
| `DATA_CREATE` | info | Record created |
| `DATA_READ` | info | Record accessed |
| `DATA_UPDATE` | info | Record modified |
| `DATA_DELETE` | warning | Record deleted |
| `DATA_EXPORT` | warning | Data exported |
| `DATA_IMPORT` | info | Data imported |

### Workflow & Agent Events

Track automation execution:

| Event | Severity | Description |
|-------|----------|-------------|
| `WORKFLOW_EXECUTED` | info | Workflow completed |
| `WORKFLOW_FAILED` | error | Workflow error |
| `AGENT_TRIGGERED` | info | Agent started |
| `AGENT_COMPLETED` | info | Agent finished |
| `AGENT_FAILED` | error | Agent error |

### MCP Events

Track MCP server interactions:

| Event | Severity | Description |
|-------|----------|-------------|
| `MCP_CONNECTION_SUCCESS` | info | Server connected |
| `MCP_CONNECTION_FAILED` | warning | Connection error |
| `MCP_TOOL_EXECUTED` | info | Tool called |
| `MCP_AUTH_REFRESHED` | info | OAuth token refreshed |

### Admin Events

Track administrative actions:

| Event | Severity | Description |
|-------|----------|-------------|
| `ADMIN_USER_CREATED` | warning | New user created |
| `ADMIN_USER_DELETED` | warning | User removed |
| `ADMIN_USER_SUSPENDED` | warning | User suspended |
| `ADMIN_CONFIG_CHANGED` | warning | Config modified |
| `ADMIN_INTEGRATION_ADDED` | info | Integration enabled |
| `ADMIN_INTEGRATION_REMOVED` | warning | Integration removed |

## Usage

### Basic Logging

```typescript
import { logAuditEvent } from "@repo/logs";

await logAuditEvent(
  "AUTH_LOGIN_SUCCESS",
  "User logged in successfully",
  "info",
  {
    userId: "user_123",
    clientIp: "192.168.1.1",
    userAgent: request.headers.get("user-agent"),
  }
);
```

### Helper Functions

Use specialized helpers for cleaner code:

#### Authentication Events

```typescript
import { logAuthEvent } from "@repo/logs";

// Success
await logAuthEvent("AUTH_LOGIN_SUCCESS", userId, true, {
  clientIp,
  method: "password", // or "oauth", "mfa"
});

// Failure
await logAuthEvent("AUTH_LOGIN_FAILED", email, false, {
  clientIp,
  reason: "Invalid password",
  attemptCount: 3,
});
```

#### Security Events

```typescript
import { logSecurityEvent } from "@repo/logs";

await logSecurityEvent(
  "SECURITY_RATE_LIMIT_EXCEEDED",
  "Rate limit exceeded for user",
  {
    userId,
    endpoint: "/api/agents/trigger",
    limit: 20,
    windowMs: 60000,
  }
);

await logSecurityEvent(
  "SECURITY_SSRF_BLOCKED",
  "Blocked request to internal network",
  {
    userId,
    blockedUrl: "http://10.0.0.1/admin",
    originalUrl: requestedUrl,
  }
);
```

#### Data Operations

```typescript
import { logDataEvent } from "@repo/logs";

await logDataEvent("CREATE", "workflow", workflowId, userId, {
  workflowName: "My Workflow",
  nodeCount: 5,
});

await logDataEvent("DELETE", "agent", agentId, userId, {
  reason: "User requested deletion",
});
```

#### Workflow/Agent Events

```typescript
import { logWorkflowEvent } from "@repo/logs";

await logWorkflowEvent("WORKFLOW_EXECUTED", workflowId, userId, true, {
  durationMs: 1500,
  nodeCount: 5,
  trigger: "webhook",
});

await logWorkflowEvent("AGENT_FAILED", agentId, userId, false, {
  error: "Timeout exceeded",
  durationMs: 30000,
  lastStep: "generate-text",
});
```

#### MCP Events

```typescript
import { logMcpEvent } from "@repo/logs";

await logMcpEvent("MCP_CONNECTION_SUCCESS", "GitHub MCP", userId, true, {
  toolCount: 15,
  transport: "HTTP",
});

await logMcpEvent("MCP_TOOL_EXECUTED", "Slack MCP", userId, true, {
  toolName: "send-message",
  durationMs: 250,
});
```

#### Admin Events

```typescript
import { logAdminEvent } from "@repo/logs";

await logAdminEvent(
  "ADMIN_USER_CREATED",
  adminUserId,
  newUserId,
  "Admin created new user account",
  {
    email: "newuser@example.com",
    role: "member",
  }
);
```

## Event Structure

All audit events follow this structure:

```typescript
interface AuditEvent {
  timestamp: string;       // ISO 8601 format
  type: AuditEventType;    // Event type constant
  severity: AuditSeverity; // info | warning | error | critical
  message: string;         // Human-readable description
  meta: {
    eventId: string;       // Unique event ID (evt_xxx)
    correlationId?: string; // Request correlation ID
    userId?: string;       // Acting user
    organizationId?: string;
    clientIp?: string;
    userAgent?: string;
    resourceType?: string;
    resourceId?: string;
    method?: string;       // HTTP method
    path?: string;         // Request path
    durationMs?: number;
    [key: string]: unknown; // Custom fields
  };
}
```

## External Webhook Integration

### Configuration

Set up external webhook for SIEM integration:

```bash
# Environment variables
AUDIT_LOG_WEBHOOK_URL=https://your-siem.com/api/events
AUDIT_LOG_WEBHOOK_TOKEN=your-bearer-token
```

### Webhook Payload

Events are sent as POST requests:

```http
POST /api/events HTTP/1.1
Host: your-siem.com
Content-Type: application/json
Authorization: Bearer your-bearer-token

{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "type": "AUTH_LOGIN_SUCCESS",
  "severity": "info",
  "message": "User logged in successfully",
  "meta": {
    "eventId": "evt_lx8k2p_abc123",
    "userId": "user_123",
    "clientIp": "192.168.1.1"
  }
}
```

### Custom Transports

Create custom transports for other destinations:

```typescript
import { addAuditTransport, type AuditTransport } from "@repo/logs";

// Datadog transport
const datadogTransport: AuditTransport = {
  async send(event) {
    await fetch("https://http-intake.logs.datadoghq.com/v1/input", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": process.env.DD_API_KEY!,
      },
      body: JSON.stringify({
        ddsource: "fabric",
        ddtags: `env:${process.env.NODE_ENV}`,
        ...event,
      }),
    });
  },
};

addAuditTransport(datadogTransport);
```

### SIEM Integration Examples

#### Splunk

```typescript
const splunkTransport: AuditTransport = {
  async send(event) {
    await fetch(`${process.env.SPLUNK_HEC_URL}/services/collector/event`, {
      method: "POST",
      headers: {
        Authorization: `Splunk ${process.env.SPLUNK_HEC_TOKEN}`,
      },
      body: JSON.stringify({
        event,
        sourcetype: "fabric:audit",
        index: "security",
      }),
    });
  },
};
```

#### Elasticsearch

```typescript
const elasticTransport: AuditTransport = {
  async send(event) {
    await fetch(`${process.env.ELASTIC_URL}/fabric-audit/_doc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${process.env.ELASTIC_API_KEY}`,
      },
      body: JSON.stringify(event),
    });
  },
};
```

## Best Practices

### 1. Always Include Context

```typescript
// Good - includes context
await logAuthEvent("AUTH_LOGIN_FAILED", email, false, {
  clientIp,
  userAgent,
  reason: "Invalid password",
  attemptCount: 3,
});

// Bad - missing context
await logAuthEvent("AUTH_LOGIN_FAILED", email, false, {});
```

### 2. Use Correlation IDs

```typescript
import { getCorrelationIdFromContext } from "@repo/api/lib/correlation-id";

await logAuditEvent("DATA_UPDATE", "Record updated", "info", {
  correlationId: getCorrelationIdFromContext(),
  userId,
  resourceId,
});
```

### 3. Log Both Success and Failure

```typescript
try {
  await performSensitiveOperation();
  await logSecurityEvent("OPERATION_SUCCESS", "Operation completed", { userId });
} catch (error) {
  await logSecurityEvent("OPERATION_FAILED", `Operation failed: ${error.message}`, {
    userId,
    error: error.message,
  });
  throw error;
}
```

### 4. Don't Log Sensitive Data

```typescript
// Good - no sensitive data
await logAuthEvent("AUTH_LOGIN_SUCCESS", userId, true, {
  clientIp,
  method: "password",
});

// Bad - logging password
await logAuthEvent("AUTH_LOGIN_SUCCESS", userId, true, {
  password: userPassword, // Never do this!
});
```

## Compliance Considerations

### GDPR

- Audit logs may contain personal data (IP, user IDs)
- Consider retention policies
- Implement right to erasure procedures

### SOC 2

- Audit logs support Change Management controls
- Enable webhook for centralized logging
- Maintain 90+ day retention

### HIPAA

- Log all access to PHI-containing resources
- Use DATA_READ events for access tracking
- Ensure log storage meets encryption requirements

## Related Documentation

- [Deployment Guide](../deployment.md)
- [Audit Logger Implementation](../../packages/logs/lib/audit-logger.ts)

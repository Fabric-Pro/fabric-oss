# Workflow Publishing & Triggers Guide

Publishing workflows, triggering them via webhook and schedule, passing dynamic payloads, and the authentication behind each path.

- **Audience**: engineers working on the Workflow Editor and its API; support engineers diagnosing a workflow that will not trigger
- **Owner**: Fabric platform team

## Table of Contents

1. [Overview](#overview)
2. [Workflow Lifecycle](#workflow-lifecycle)
3. [Publishing Workflows](#publishing-workflows)
4. [Trigger Types](#trigger-types)
5. [Webhook Triggers](#webhook-triggers)
6. [Authentication](#authentication)
7. [Passing Dynamic Payloads](#passing-dynamic-payloads)
8. [Variable Referencing](#variable-referencing)
9. [Version Management](#version-management)
10. [Security Best Practices](#security-best-practices)
11. [API Reference](#api-reference)
12. [Examples](#examples)

---

## Overview

The Fabric workflow system allows you to build visual automation workflows that can be:

- **Manually triggered** from the UI during development
- **Published** for production use with versioning
- **Externally triggered** via webhooks with secure authentication
- **Dynamically configured** by passing payloads that nodes can reference

### Key Components

| Component | Description |
|-----------|-------------|
| **Workflow** | A visual automation consisting of connected nodes |
| **Version** | An immutable snapshot of a workflow at a point in time |
| **Trigger** | The mechanism that starts a workflow execution |
| **Execution** | A single run of a workflow with its own logs and output |
| **API Key** | Credential for authenticating webhook triggers |

---

## Workflow Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                       WORKFLOW LIFECYCLE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────┐    ┌───────────┐    ┌───────────┐    ┌─────────┐ │
│   │  DRAFT  │───▶│ PUBLISHED │───▶│  ACTIVE   │───▶│ARCHIVED │ │
│   └─────────┘    └───────────┘    └───────────┘    └─────────┘ │
│        │              │                │                        │
│        │              │                │                        │
│        ▼              ▼                ▼                        │
│   • Editable    • Versioned      • Running         • Read-only │
│   • Test runs   • Webhook URL    • Scheduled       • Historical│
│   • No triggers • API keys       • Monitoring                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Status Definitions

| Status | Description | Can Edit | Can Trigger |
|--------|-------------|----------|-------------|
| `DRAFT` | Work in progress, not yet published | ✅ | Manual only |
| `PUBLISHED` | Production-ready, has version history | ✅ | ✅ All methods |
| `ACTIVE` | Actively running with schedules | ✅ | ✅ All methods |
| `PAUSED` | Temporarily disabled | ✅ | ❌ Paused |
| `ARCHIVED` | No longer in use | ❌ | ❌ Disabled |

---

## Publishing Workflows

Publishing creates an immutable version snapshot and enables external triggers.

### What Happens When You Publish

1. **Version Snapshot Created**
   - Current nodes, edges, and configuration are saved
   - Version number is incremented
   - Changelog can be added for documentation

2. **Workflow Status Updated**
   - Status changes to `PUBLISHED`
   - `publishedAt` timestamp is set
   - `publishedVersion` points to the new version

3. **Webhook Configuration** (if enabled)
   - Unique webhook URL is generated
   - Webhook secret is created for signature verification
   - Trigger type is set to `WEBHOOK`

### What a trigger executes

**Every trigger path runs the workflow's current graph, not the published
snapshot.**

| Path | Graph it executes |
|---|---|
| Manual run from the editor | the nodes/edges posted by the editor, or the stored current graph |
| Webhook | the stored **current** graph (`workflow.nodes`) |
| Schedule | the stored **current** graph, loaded by `getWorkflowDefinition` |

`WorkflowVersion` rows are written on publish and read by version history and
rollback. Nothing reads them at execution time.

So editing a published workflow changes what its webhook and schedule run, with
no second publish. There is no "draft vs live" separation — publishing gates
*whether* external triggers are accepted, not *which* graph they run.

A webhook execution records `version: publishedVersion ?? version` while
executing the current graph, so `WorkflowExecution.version` names the published
version rather than the graph that ran. Read it as "the version published at
the time", not as a pointer you can replay.

### Publishing via UI

1. Open your workflow in the editor
2. Click the **Publish** button in the toolbar
3. Configure publishing options:
   - Add an optional changelog message
   - Enable/disable webhook trigger
   - Enable/disable scheduled trigger
4. Click **Publish Workflow**
5. Copy the webhook URL and secret if using webhooks

### Publishing via API

```typescript
// POST /api/workflows/publish
const response = await fetch('/api/workflows/publish', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`
  },
  body: JSON.stringify({
    workflowId: 'wf_abc123',
    changelog: 'Added Slack notification step',
    enableWebhook: true,
    enableSchedule: false
  })
});

const result = await response.json();
// {
//   success: true,
//   version: 3,
//   publishedAt: "2024-01-15T10:30:00Z",
//   webhookUrl: "https://app.example.com/api/workflows/trigger/wf_abc123",
//   webhookSecret: "whsec_a1b2c3d4..."
// }
```

### Permission Requirements

Publish, unpublish and rollback all require **ownership** of the workflow:

- A **personal** workflow can only be acted on by its owner.
- An **organization** workflow requires that you are a member of that
  organization **and** that you own the workflow.

Workflows stay user-owned inside an organization — `workflows.get`,
`workflows.versions.list` and `workflows.executions.start` all resolve access
the same way, so a colleague who cannot open your workflow cannot publish,
stop or roll it back either.

```typescript
// The single shared gate, in packages/database/prisma/queries/workflows.
// Personal: owner only. Organization: member AND owner.
if (!(await hasWorkflowAccess(workflowId, userId))) {
  throw new ORPCError("NOT_FOUND", { message: "Workflow not found" });
}
```

A caller who fails the gate gets `NOT_FOUND` rather than `FORBIDDEN`, matching
the read paths — the API does not confirm that a workflow you cannot reach
exists.

> Membership alone used to be sufficient for these three mutations, which let
> any member of the organization publish a colleague's unfinished draft, stop
> a live workflow, or roll one back over its author's current graph.
> `requirePermission` short-circuits in personal context, so the org role never
> constrained this on its own.

---

## Trigger Types

Workflows can be started through multiple trigger mechanisms:

### 1. Manual Trigger

- Triggered from the UI by clicking "Run"
- Used during development and testing
- No authentication required (uses session)
- Full access to execution logs in real-time

### 2. Webhook Trigger

- External HTTP POST request to the workflow URL
- Requires authentication (API key or signature)
- Accepts JSON payload for dynamic data
- Returns execution ID for tracking

### 3. Scheduled Trigger

Cron-based scheduling, backed by a Temporal Schedule.

- The cron expression lives on the **trigger node's own config**
  (`data.config.triggerType === "schedule"` plus `scheduleCron`, or the older
  `scheduleExpression`) — not in the workflow's `triggerConfig` column.
  `findScheduleCron(nodes)` is the single reader.
- A schedule only becomes live on **publish**. Saving an already-published
  workflow re-syncs it in place, so editing the cron takes effect without an
  unpublish/republish cycle. Unpublish, delete and a rollback to a graph with a
  different cron all sync too.
- The schedule id is derived from the workflow id
  (`workflow-builder-<workflowId>`) rather than stored, so the two cannot
  drift; a reconciler sweeps by that prefix.
- Runs are dispatched to the `workflow-builder` task queue with
  `overlap: SKIP` — a run that overruns its next slot is skipped rather than
  stacked, since user-authored workflows commonly have external side effects.

A cron that Temporal rejects surfaces as a `failed` outcome on the publish
response rather than an exception; the workflow still publishes.

### 4. Event Trigger (Future)

- Triggered by system events
- Integration with external services
- Real-time reactive workflows

---

## Webhook Triggers

Webhook triggers allow external systems to start workflow executions via HTTP.

### Webhook URL Format

```
POST https://your-domain.com/api/workflows/trigger/{workflowId}
```

### Request Format

```http
POST /api/workflows/trigger/wf_abc123 HTTP/1.1
Host: app.example.com
Content-Type: application/json
Authorization: Bearer wfk_abc1_your-secret-key-here

{
  "prompt": "Analyze this data",
  "data": {
    "source": "external-api",
    "items": [1, 2, 3]
  },
  "options": {
    "verbose": true
  }
}
```

### Response Format

**Success (200)**
```json
{
  "success": true,
  "executionId": "exec_xyz789",
  "temporalWorkflowId": "workflow-exec_xyz789",
  "message": "Workflow triggered successfully"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `Invalid JSON payload` | Request body is not valid JSON |
| 401 | `Unauthorized` | Invalid or missing authentication |
| 403 | `Workflow is not published` | Workflow status is not PUBLISHED/ACTIVE |
| 403 | `Webhook trigger not enabled` | Trigger type is not WEBHOOK |
| 404 | `Workflow not found` | Workflow ID doesn't exist |
| 500 | `Failed to trigger workflow` | Internal server error |

### Webhook Health Check

You can verify a webhook endpoint is configured correctly:

```http
GET /api/workflows/trigger/wf_abc123 HTTP/1.1
Host: app.example.com
```

Response:
```json
{
  "workflowId": "wf_abc123",
  "name": "My Automation Workflow",
  "status": "PUBLISHED",
  "triggerType": "WEBHOOK",
  "webhookEnabled": true,
  "publishedVersion": 3
}
```

---

## Authentication

Webhook triggers support two authentication methods:

### Method 1: API Key Authentication

API keys are generated per-workflow and provide granular access control.

**There is no editor UI for them today.** `workflows.apiKeys.{create,list,revoke}` are
wired into the oRPC router and the trigger route accepts the keys they issue, but no
component in `apps/web/modules/saas/workflows` calls those procedures, so a customer
cannot obtain a `wfk_` key from the product. Signature authentication (Method 2) is the
path the UI supports end to end, and it is the one the customer documentation describes.
Treat this section as the contract for whoever builds the panel.

#### API Key Format

```
wfk_{prefix}_{secret}

Example: wfk_abc1_k8j2m9x4p7q3r6t1w5y8z0
         │    │    └─── Secret portion (random)
         │    └──────── Prefix for identification
         └───────────── Workflow key identifier
```

#### Using API Keys

```bash
curl -X POST "https://app.example.com/api/workflows/trigger/wf_abc123" \
  -H "Authorization: Bearer wfk_abc1_k8j2m9x4p7q3r6t1w5y8z0" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello world"}'
```

#### API Key Properties

| Property | Description |
|----------|-------------|
| `name` | User-friendly identifier (e.g., "Production API") |
| `permissions` | Array of allowed actions: `trigger`, `read`, `admin` |
| `expiresAt` | Optional expiration date |
| `isActive` | Can be disabled without deletion |
| `usageCount` | Tracks how many times the key was used |
| `lastUsedAt` | Timestamp of last successful use |

#### Creating API Keys

There is no REST route for this — the procedure is oRPC only, at
`workflows.apiKeys.create`:

```typescript
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";

const createKey = useMutation(orpc.workflows.apiKeys.create.mutationOptions());

const { rawKey } = await createKey.mutateAsync({
  workflowId: "wf_abc123",
  name: "Production Webhook",
  permissions: ["trigger"],
  expiresAt: "2026-12-31T23:59:59Z", // optional
});
// `rawKey` is the only time the full `wfk_...` value exists; the row stores a hash.
```

### Method 2: Webhook Signature Authentication

For systems that prefer HMAC-based verification (like GitHub webhooks).

#### How It Works

1. When you publish with webhooks enabled, a `webhookSecret` is generated
2. The calling system signs the request body with this secret
3. The signature is sent in the `x-workflow-signature` header
4. Our system verifies the signature matches

#### Signature Format

```
x-workflow-signature: sha256={hmac_hex_digest}
```

#### Generating the Signature

```javascript
const crypto = require('crypto');

const payload = JSON.stringify({ prompt: "Hello world" });
const secret = 'whsec_your-webhook-secret';
const signature = crypto
  .createHmac('sha256', secret)
  .update(payload)
  .digest('hex');

// Send with header: x-workflow-signature: sha256={signature}
```

```python
import hmac
import hashlib
import json

payload = json.dumps({"prompt": "Hello world"})
secret = b'whsec_your-webhook-secret'
signature = hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()

# Send with header: x-workflow-signature: sha256={signature}
```

#### Verification Process

```typescript
function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  
  // Timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expectedSignature}`),
  );
}
```

### Authentication Priority

1. **API Key** is checked first (if `Authorization: Bearer` header present)
2. **Webhook Signature** is checked second (if `x-workflow-signature` header present)
3. If both fail or neither provided, request is rejected with 401

---

## Passing Dynamic Payloads

The trigger payload becomes available to all nodes in the workflow through variable interpolation.

### Payload Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                         PAYLOAD FLOW                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐                                             │
│  │  HTTP Request   │                                             │
│  │  {              │                                             │
│  │    "prompt": "..."│                                           │
│  │    "data": {...}  │                                           │
│  │  }              │                                             │
│  └────────┬────────┘                                             │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐                                             │
│  │  Webhook Route  │  Parses JSON, validates auth                │
│  └────────┬────────┘                                             │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐                                             │
│  │ Temporal Start  │  triggerData = payload                      │
│  └────────┬────────┘                                             │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐                                             │
│  │   Workflow      │  variables = {...input.variables,           │
│  │   Execution     │              ...input.triggerData}          │
│  └────────┬────────┘                                             │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐     ┌─────────────────┐                     │
│  │  Trigger Node   │────▶│  Other Nodes    │                     │
│  │  output: {      │     │  Can reference: │                     │
│  │    data: {...}  │     │  {{Trigger.data.prompt}}             │
│  │  }              │     │  {{Trigger.data.options.verbose}}    │
│  └─────────────────┘     └─────────────────┘                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Payload Structure

Any valid JSON can be sent as the trigger payload:

```json
{
  "prompt": "Generate a summary",
  "context": {
    "source": "email",
    "sender": "john@example.com",
    "subject": "Q4 Report"
  },
  "options": {
    "format": "markdown",
    "maxLength": 500,
    "includeMetadata": true
  },
  "tags": ["urgent", "finance"],
  "metadata": {
    "requestId": "req_123",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

### Accessing Payload in Nodes

The payload is available through the Trigger node's output:

| Reference | Value |
|-----------|-------|
| `{{Trigger.data.prompt}}` | `"Generate a summary"` |
| `{{Trigger.data.context.source}}` | `"email"` |
| `{{Trigger.data.context.sender}}` | `"john@example.com"` |
| `{{Trigger.data.options.format}}` | `"markdown"` |
| `{{Trigger.data.options.maxLength}}` | `500` |
| `{{Trigger.data.tags}}` | `["urgent", "finance"]` |
| `{{Trigger.data.metadata.requestId}}` | `"req_123"` |

---

## Variable Referencing

Nodes can reference outputs from previous nodes and trigger data using template syntax.

### Syntax

```
{{NodeLabel.fieldPath}}
```

### Reference Methods

#### 1. By Node Label (Recommended)

Use the human-readable label assigned to the node:

```
{{Generate Text.text}}
{{Scrape Website.markdown}}
{{MCP Tool.output}}
```

#### 2. By Node ID

Use the technical node ID (prefixed with `$`):

```
{{$ai-generate-text-abc123.text}}
{{$firecrawl-scrape-xyz789.markdown}}
```

### Common Output Fields by Node Type

| Node Type | Output Fields |
|-----------|---------------|
| **Trigger** | `data` (entire payload), `data.fieldName` |
| **Generate Text** | `text`, `usage`, `model` |
| **Generate Image** | `imageUrl`, `revisedPrompt` |
| **HTTP Request** | `data`, `status`, `headers` |
| **Firecrawl Scrape** | `markdown`, `html`, `metadata` |
| **Firecrawl Search** | `results`, `count` |
| **MCP Tool** | `output`, `text`, `slack`, `json`, `toolName` |
| **Slack Send** | `messageId`, `channel`, `timestamp` |
| **Email Send** | `messageId`, `status` |
| **Condition** | `result` (boolean) |
| **Linear Create** | `issueId`, `url`, `identifier` |

### Nested Access

Access nested properties using dot notation:

```
{{Trigger.data.user.profile.email}}
{{HTTP Request.data.results[0].title}}
{{MCP Tool.output.items[0].name}}
```

### Example: Full Workflow with Dynamic Payload

**Trigger Payload:**
```json
{
  "topic": "artificial intelligence",
  "targetAudience": "developers",
  "slackChannel": "#tech-updates"
}
```

**Node Configurations:**

1. **Trigger Node** → Receives payload
   - Output: `{{Trigger.data}}`

2. **Generate Text Node** (Label: "Research")
   - Prompt: `Research the latest developments in {{Trigger.data.topic}} for {{Trigger.data.targetAudience}}`
   - Output: `{{Research.text}}`

3. **Generate Text Node** (Label: "Summarize")
   - Prompt: `Summarize this research for a quick Slack update: {{Research.text}}`
   - Output: `{{Summarize.text}}`

4. **Slack Send Node**
   - Channel: `{{Trigger.data.slackChannel}}`
   - Message: `📢 *Tech Update*\n\n{{Summarize.text}}`

---

## Version Management

Published workflows maintain a complete version history.

### Version Structure

Each version contains:

```typescript
interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;           // Incrementing version number
  nodes: object;             // Snapshot of nodes
  edges: object;             // Snapshot of edges
  variables: object | null;  // Workflow variables
  settings: object | null;   // Workflow settings
  triggerConfig: object | null;
  changelog: string | null;  // User-provided description
  isPublished: boolean;      // Whether this version was published
  publishedAt: Date | null;
  createdBy: string;         // User who created this version
  createdAt: Date;
}
```

### Viewing Version History

The Version History panel in the workflow editor shows:

- Version number and publish date
- Who published the version
- Changelog message
- Option to rollback

### Rolling Back to a Previous Version

```typescript
// POST /api/workflows/rollback
const response = await fetch('/api/workflows/rollback', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`
  },
  body: JSON.stringify({
    workflowId: 'wf_abc123',
    targetVersion: 2,
    reason: 'Bug in version 3'
  })
});
```

Rollback:
1. Creates a new version (e.g., v4) with the content from the target version (v2)
2. Updates the workflow to use the new version
3. Maintains the complete history (v1, v2, v3, v4)
4. Re-syncs the Temporal Schedule against the **restored** graph, because the
   cron lives on the trigger node and rolling back can change or remove it. A
   workflow still in `DRAFT` has its schedule removed rather than made live.

The new version row carries the parent workflow's `userId` and
`organizationId`. `workflow_version` has a `user_owned` RLS policy keyed on
those columns, so a row left with both `NULL` matches neither the organization
branch nor the personal branch and is invisible to the very version history
that should list it.

---

## Security Best Practices

### API Key Management

1. **Use descriptive names**: Name keys by environment/purpose (e.g., "Production - GitHub Actions")

2. **Set expiration dates**: Rotate keys regularly
   ```json
   { "expiresAt": "2025-06-30T23:59:59Z" }
   ```

3. **Limit permissions**: Only grant necessary permissions
   ```json
   { "permissions": ["trigger"] }  // Not ["trigger", "read", "admin"]
   ```

4. **Monitor usage**: Check `lastUsedAt` and `usageCount` for anomalies

5. **Revoke compromised keys immediately**: Set `isActive: false`

### Webhook Security

1. **Always use HTTPS** in production

2. **Validate signatures** when using webhook secret method:
   ```javascript
   if (!verifySignature(payload, signature, secret)) {
     return res.status(401).json({ error: 'Invalid signature' });
   }
   ```

3. **Keep webhook secrets confidential**: Store in environment variables, not code

4. **Regenerate secrets** if compromised:
   - Unpublish the workflow
   - Re-publish to generate new secret
   - Update all integrations with new secret

### Payload Validation

While the system accepts any JSON, validate payloads in your workflows:

1. **Use Condition nodes** to check required fields exist
2. **Set defaults** in your node configurations
3. **Handle missing data gracefully** in prompts

---

## API Reference

### Publish Workflow

```
POST /api/workflows/publish
```

**Request Body:**
```json
{
  "workflowId": "string (required)",
  "changelog": "string (optional)",
  "enableWebhook": "boolean (optional, default: false)",
  "enableSchedule": "boolean (optional, default: false)"
}
```

**Response:**
```json
{
  "success": true,
  "version": 1,
  "publishedAt": "2024-01-15T10:30:00Z",
  "webhookUrl": "string (if enableWebhook)",
  "webhookSecret": "string (if enableWebhook)"
}
```

### Unpublish Workflow

```
POST /api/workflows/unpublish
```

**Request Body:**
```json
{
  "workflowId": "string (required)"
}
```

### Rollback Workflow

```
POST /api/workflows/rollback
```

**Request Body:**
```json
{
  "workflowId": "string (required)",
  "targetVersion": "number (required)",
  "reason": "string (optional)"
}
```

### Trigger Workflow

```
POST /api/workflows/trigger/{workflowId}
```

**Headers:**
- `Authorization: Bearer {api_key}` OR
- `x-workflow-signature: sha256={signature}`
- `Content-Type: application/json`

**Request Body:**
Any valid JSON payload

### Get Workflow Trigger Info

```
GET /api/workflows/trigger/{workflowId}
```

---

## Examples

### Example 1: AI-Powered Content Pipeline

**Use Case:** Generate social media posts from a topic

**Trigger Payload:**
```json
{
  "topic": "sustainable technology",
  "platforms": ["twitter", "linkedin"],
  "tone": "professional"
}
```

**cURL:**
```bash
curl -X POST "https://app.example.com/api/workflows/trigger/wf_content" \
  -H "Authorization: Bearer wfk_abc1_secret123" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "sustainable technology",
    "platforms": ["twitter", "linkedin"],
    "tone": "professional"
  }'
```

### Example 2: GitHub Integration

**Use Case:** Trigger workflow when GitHub issue is created

**GitHub Webhook Configuration:**
- Payload URL: `https://app.example.com/api/workflows/trigger/wf_github`
- Content type: `application/json`
- Secret: `whsec_your-secret`

**Node Configuration:**
```
Issue Title: {{Trigger.data.issue.title}}
Issue Body: {{Trigger.data.issue.body}}
Repository: {{Trigger.data.repository.full_name}}
```

### Example 3: Slack Slash Command

**Use Case:** `/analyze <topic>` command triggers research workflow

**Slack App Configuration:**
- Request URL: `https://app.example.com/api/workflows/trigger/wf_analyze`

**Middleware to Transform Slack Payload:**
```javascript
// Transform Slack's form-encoded data to JSON
app.post('/slack-to-workflow', (req, res) => {
  const payload = {
    topic: req.body.text,
    userId: req.body.user_id,
    channel: req.body.channel_id
  };
  
  // Forward to workflow
  fetch(workflowUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
});
```

### Example 4: Scheduled Data Processing

**Use Case:** Daily report generation with configurable parameters

**Trigger Payload (from scheduler):**
```json
{
  "reportType": "daily",
  "dateRange": {
    "start": "2024-01-14",
    "end": "2024-01-15"
  },
  "recipients": ["team@example.com"],
  "format": "pdf"
}
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Invalid API key | Check key is active and not expired |
| 403 Not published | Workflow in DRAFT | Publish the workflow first |
| 403 Webhook not enabled | triggerType != WEBHOOK | Re-publish with webhook enabled |
| Variable not found | Incorrect reference | Check node label and field name |
| Empty payload | No request body | Ensure Content-Type is application/json |

### Debugging Tips

1. **Check execution logs** in the UI for detailed node-by-node output
2. **Use the GET endpoint** to verify workflow status
3. **Test with simple payloads** before complex ones
4. **Verify node labels** match your references exactly (case-sensitive)

---

## Next Steps

- [Creating Workflows](./creating-workflows.md)
- [Node Types Reference](./node-types.md)
- [Integration Configuration](./integrations.md)
- [Temporal Workflow Durability](./temporal-durability.md)


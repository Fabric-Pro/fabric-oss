# Phase B: Slack Conversational Threads - Refined Implementation Plan

## Architecture Validation

**Confirmed Reuse Strategy:**
- ✅ `slackMentionHandlerWorkflow` (exists)
- ✅ `triggerEventWorkflow` (exists)
- ✅ `AgentDeploymentTrigger` model (exists)
- ✅ Temporal trigger activities (exist)
- ✅ Slack connector thread metadata (exists)

**Key Principle:** Extend current trigger architecture into conversational threads, don't duplicate.

---

## Refined Database Schema (B1)

### Model 1: `SlackThreadMapping`

```prisma
model SlackThreadMapping {
  id              String   @id @default(cuid())
  
  // Slack identifiers
  slackTeamId     String
  slackChannelId  String
  slackThreadTs   String   // Parent message timestamp (thread ID)
  
  // Fabric identifiers
  deploymentId    String
  triggerId       String?
  workflowId      String?  // ADDED: Active workflow identity
  conversationId  String?  // Links to AgentConversation
  
  // State
  status          String   @default("active") // active, paused, closed
  lastMessageTs   String?  // Last processed message timestamp
  
  // Context preservation
  contextJson     Json?    // Lightweight summary for fast resume
  // Note: Full conversation history stays in existing conversation/workflow state
  
  // Timeout tracking
  timeoutAt       DateTime? // When thread auto-closes
  
  // Tenant isolation
  userId          String?
  organizationId  String?
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([slackTeamId, slackChannelId, slackThreadTs])
  @@index([deploymentId])
  @@index([workflowId])        // ADDED: For quick workflow lookup
  @@index([conversationId])    // ADDED: For conversation linkage
  @@index([status])
  @@index([userId])
  @@index([organizationId])
  @@map("slack_thread_mapping")
}
```

### Model 2: `SlackEventReceipt` (NEW - Idempotency)

```prisma
model SlackEventReceipt {
  id             String   @id @default(cuid())
  slackEventId   String   @unique  // Slack's event_id for deduplication
  slackTeamId    String
  slackChannelId String?
  slackMessageTs String?
  processedAt    DateTime @default(now())
  
  // Tenant isolation
  organizationId String?
  userId         String?

  @@index([slackTeamId])
  @@index([slackEventId])  // For quick dedupe lookup
  @@index([userId])
  @@index([organizationId])
  @@map("slack_event_receipt")
}
```

**Key Decisions:**
- ✅ `workflowId` stored directly for easy signaling
- ✅ Tokens at integration level, not per-deployment
- ✅ Hybrid persistence: canonical history in existing systems, summary in mapping
- ✅ Plain text replies first, Block Kit optional later
- ✅ Timeout: default 24h, configurable (1h, 8h, 24h, 7d, never)

---

## Refined Implementation Order

### B1: Schema + Migration (1-2 days)
- Create `SlackThreadMapping` with `workflowId`
- Create `SlackEventReceipt` for idempotency
- Add `timeoutAt` field
- Migration script

### B2a: Events Endpoint Core (2-3 days)
**New: `apps/web/app/api/webhooks/slack/events/route.ts`**

Core responsibilities:
- URL verification (initial setup)
- Request signature verification (Slack signing secret)
- Idempotency check (`SlackEventReceipt`)
- Bot-loop protection (beyond just `bot_id`)
- Event parsing and validation

**Bot-Loop Protection Checklist:**
```typescript
// Skip if:
- event.bot_id exists
- event.user === bot user ID
- event.subtype exists (edited, message_changed, etc.)
- event.event_id already in SlackEventReceipt
- X-Slack-Retry-Num header indicates retry (optional)

// Only process:
- event.type === "app_mention" (in channel)
- event.type === "message" && event.channel_type === "im" (DM)
- No subtype
- Not from bot
```

**DM vs Channel Thread Distinction:**
```typescript
type ThreadType = "channel" | "dm";

// Channel thread: team + channel + parentTs
// DM conversation: team + channel (no threadTs for simple DMs)

if (event.channel_type === "im") {
  threadType = "dm";
  threadKey = { teamId, channelId }; // No threadTs
} else {
  threadType = "channel";
  threadKey = { teamId, channelId, threadTs: event.thread_ts || event.ts };
}
```

### B3: Thread Management Activities (2 days)
**New: `packages/temporal/src/activities/trigger-system/slack-threads.ts`**

```typescript
// Core activities
export async function getOrCreateThreadMapping(params: {
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string;
  deploymentId: string;
  userId: string;
  organizationId?: string;
  timeoutHours?: number; // default: 24
}): Promise<{
  mappingId: string;
  isNew: boolean;
  existingWorkflowId?: string;
  existingConversationId?: string;
  context?: Record<string, unknown>;
}>;

export async function recordEventReceipt(params: {
  slackEventId: string;
  slackTeamId: string;
  slackChannelId?: string;
  slackMessageTs?: string;
  organizationId?: string;
  userId?: string;
}): Promise<void>;

export async function updateThreadState(params: {
  mappingId: string;
  workflowId?: string;
  conversationId?: string;
  lastMessageTs: string;
  contextJson?: Record<string, unknown>;
  status?: "active" | "paused" | "closed";
}): Promise<void>;

export async function sendSlackReply(params: {
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string;
  text: string;
  // Minimal formatting only (no Block Kit for v1)
  // Optional: unfurl_links, markdown parsing
}): Promise<{
  messageTs: string;
  ok: boolean;
}>;

export async function checkThreadTimeout(params: {
  mappingId: string;
}): Promise<{
  isTimedOut: boolean;
  shouldClose: boolean;
}>;
```

### B2b: Event Routing into Workflows (2 days)
**Update endpoint to use activities:**

```typescript
// Pseudo-code for B2b
export async function POST(request: NextRequest) {
  // ... B2a verification ...
  
  // 1. Record receipt for idempotency
  await activities.recordEventReceipt({ slackEventId: event.event_id, ... });
  
  // 2. Get or create thread mapping
  const mapping = await activities.getOrCreateThreadMapping({
    slackTeamId: payload.team_id,
    slackChannelId: event.channel,
    slackThreadTs: event.thread_ts || event.ts,
    deploymentId, // From trigger lookup
    timeoutHours: triggerConfig.timeoutHours || 24,
  });
  
  // 3. Check timeout
  const timeoutCheck = await activities.checkThreadTimeout({
    mappingId: mapping.mappingId,
  });
  
  // 4. Routing decision
  if (mapping.existingWorkflowId && !timeoutCheck.isTimedOut) {
    // Signal existing workflow
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(mapping.existingWorkflowId);
    await handle.signal(slackMentionSignal, {
      eventId: event.event_id,
      channel: event.channel,
      user: { id: event.user, name: userName },
      text: cleanText, // Remove @Fabric mention
      threadTs: event.thread_ts,
      ts: event.ts,
    });
  } else {
    // Start new workflow
    const workflowId = `slack-thread-${payload.team_id}-${event.channel}-${event.ts}`;
    await temporalClient.workflow.start("slackMentionHandlerWorkflow", {
      workflowId,
      taskQueue: "trigger-system",
      args: [{
        triggerId,
        workspaceId: payload.team_id,
        botUserId,
        userId,
        organizationId,
      }],
    });
    
    // Update mapping with new workflow
    await activities.updateThreadState({
      mappingId: mapping.mappingId,
      workflowId,
      lastMessageTs: event.ts,
    });
  }
  
  return NextResponse.json({ ok: true });
}
```

### B4: Reply Integration (2 days)
**Update: `packages/temporal/src/workflows/trigger-system/index.ts`**

Modify `triggerEventWorkflow` output handling:

```typescript
// After agent invocation
if (triggerConfig.outputConfig?.slackReply) {
  // Get Slack access token from integration (not deployment)
  const slackToken = await activities.getSlackIntegrationToken({
    teamId: event.context.metadata.workspaceId,
    organizationId,
  });
  
  // Send plain text reply
  const replyResult = await activities.sendSlackReply({
    slackTeamId: event.context.metadata.workspaceId,
    slackChannelId: event.context.sourceId,
    slackThreadTs: event.context.metadata.threadTs,
    text: agentResult.response,
  });
  
  // Update thread mapping
  await activities.updateThreadState({
    mappingId: event.context.metadata.threadMappingId,
    lastMessageTs: replyResult.messageTs,
    contextJson: { 
      lastResponse: agentResult.response,
      messageCount: (existingCount || 0) + 1,
    },
  });
}
```

### B5: UI Configuration (1-2 days)
**Update: `TriggersSheet.tsx` Slack configuration**

Product-friendly labels:

```typescript
// Instead of:
// "Thread persistence"
// "Reply in threads"

// Use:
// "Reply in Slack threads"
// "Keep Slack conversations active for"
// "Continue existing thread conversations"
// "Post agent replies back into Slack"
```

Configuration options:
```typescript
interface SlackTriggerConfig {
  enabled: boolean;
  replyInThreads: boolean;        // NEW
  threadTimeoutHours: number;     // 1, 8, 24 (default), 168 (7d), 0 (never)
  // Defer to later:
  // useRichFormatting?: boolean; // Block Kit
  // customResponseTemplate?: string;
}
```

---

## Conversation Continuity Rules (V1)

```
ON Slack message arrives:
  IF event_id in SlackEventReceipt:
    RETURN 200 OK (already processed)
  
  IF from bot OR has subtype:
    RETURN 200 OK (ignore)
  
  LOOKUP SlackThreadMapping by (team, channel, threadTs)
  
  IF mapping exists AND status = "active" AND NOT timed out:
    SIGNAL existing workflow
  ELSE IF mapping exists AND (closed OR timed out):
    START new workflow
    UPDATE mapping with new workflowId
  ELSE:
    CREATE new mapping
    START new workflow
    
  RECORD event receipt
  RETURN 200 OK
```

---

## Token Storage Architecture

```
┌─────────────────────────────────────────┐
│  IntegrationConnection (existing)       │
│  - provider: "SLACK"                    │
│  - credentials: { accessToken }         │
│  - teamId, teamName                     │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  AgentDeploymentTrigger                 │
│  - type: "SLACK_MENTION"                │
│  - slackChannelId (optional)            │
│  - slackTeamId (reference)              │
│  - config: { timeoutHours, replyMode }  │
│  - DOES NOT store token                 │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  SlackThreadMapping                     │
│  - Links to deployment                  │
│  - Runtime state only                   │
│  - No credentials                       │
└─────────────────────────────────────────┘
```

**Resolution at runtime:**
```typescript
// 1. Get deployment trigger
const trigger = await db.agentDeploymentTrigger.findFirst({...});

// 2. Get integration connection for token
const integration = await db.integrationConnection.findFirst({
  where: {
    provider: "SLACK",
    "credentials.teamId": trigger.slackTeamId,
    userId: trigger.userId, // or org-level
  },
});

const accessToken = integration.credentials.accessToken;
```

---

## Testing Strategy

| Test | Method |
|------|--------|
| Idempotency | Same event_id twice → only one reply |
| Bot-loop | Bot message → no processing |
| Thread continuity | 3 messages in same thread → same workflow signaled |
| Timeout | Wait 24h → new workflow started |
| DM vs channel | DM → no threadTs; Channel mention → threadTs used |
| Signature verification | Invalid signature → 401 |
| Reply delivery | Agent response appears in Slack thread |

---

## Biggest Risk Mitigation

**Risk:** Conversation continuity semantics confusion

**Mitigation:** 
- V1 rule is explicit and simple
- Clear logging at each routing decision
- Metrics on: new vs existing workflows, timeout rate

---

## First Implementation Slice

**Ready to implement:** B1 + B2a (schema + events endpoint with verification + idempotency)

This validates the webhook/event intake before wiring the full reply loop.

**Decision needed:** Proceed with B1 + B2a first?

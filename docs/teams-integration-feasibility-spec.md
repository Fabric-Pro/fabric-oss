# Teams Integration Feasibility Spec (T0)

## Objective
Determine the correct architecture and implementation path for Microsoft Teams conversational agent support before committing to database schema or full implementation.

---

## Key Questions to Answer

### 1. Inbound Message Path

#### Option A: Azure Bot Service (Recommended)
**Architecture:** Register Azure Bot → Configure Teams channel → Bot Framework SDK handles webhook

**Endpoint:** `POST /api/webhooks/teams/api/messages`

**Pros:**
- Official Microsoft-supported path
- Handles authentication automatically
- Supports all conversation types (personal, group, channel)
- Built-in typing indicators, message formatting
- Conversation state management

**Cons:**
- Requires Azure Bot registration (separate from Graph integration)
- Additional infrastructure dependency
- Bot Framework SDK complexity

#### Option B: Graph API Subscriptions (Webhooks)
**Architecture:** Subscribe to `/chats/{id}/messages` changes

**Endpoint:** `POST /api/webhooks/microsoft-graph/teams`

**Pros:**
- No Azure Bot needed
- Uses existing Graph integration

**Cons:**
- **Only supports channels, not personal/group chats**
- No @mention detection for bot
- Requires admin consent for webhook subscriptions
- Subscription lifecycle management (renewal every 3 days)
- Cannot proactively message without prior conversation context

**Verdict:** ❌ Not viable for "@Fabric" mention parity

#### Option C: Teams Incoming Webhooks (Connector)
**Architecture:** Configure webhook URL per channel

**Pros:**
- Simple HTTP POST
- No Azure Bot

**Cons:**
- One-way only (incoming)
- Cannot reply into same thread context
- Channel-specific (not global)
- No @mention support
- Deprecated in favor of Workflows

**Verdict:** ❌ Not viable for conversational parity

### 2. Reply Transport Path

#### Bot Framework Reply API
```typescript
// Within Bot Framework turn context
await context.sendActivity({
  type: ActivityTypes.Message,
  text: "Agent response here"
});
```

**Pros:**
- Automatic reply to same conversation
- Handles thread context implicitly
- Supports rich cards, adaptive cards

#### Graph API Direct
```typescript
// POST /v1.0/chats/{chat-id}/messages
await fetch(`https://graph.microsoft.com/v1.0/chats/${chatId}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify({ body: { content: "Response" } })
});
```

**Pros:**
- Works outside Bot Framework context
- More control over message format

**Cons:**
- Requires `chat-id` lookup
- Separate authentication flow

**Recommendation:** Use Bot Framework for replies (simpler), Graph API as fallback

### 3. Supported Conversation Surfaces

| Surface | Azure Bot | Graph Sub | Notes |
|---------|-----------|-----------|-------|
| Personal chat | ✅ | ❌ | 1:1 with bot |
| Group chat | ✅ | ❌ | Multi-user chat |
| Channel mention | ✅ | ⚠️ Limited | @bot mention in channel |
| Channel thread | ✅ | ⚠️ Limited | Reply in threaded conversation |

**Critical finding:** Graph subscriptions do NOT support personal/group chats for message changes. Only Azure Bot provides full coverage.

### 4. Conversation Identity Model

**Teams Activity Schema (Bot Framework):**
```json
{
  "conversation": {
    "id": "a:1jxxxxxxxxxxxxxxxxxxxxxx",
    "conversationType": "personal" | "groupChat" | "channel",
    "tenantId": "72f988bf-86f1-41af-91ab-2d7cd011db47",
    "name": "optional-group-name"
  },
  "from": {
    "id": "29:1ixxxxxxxxxxxxxxxxxxxxxx",
    "name": "User Name",
    "aadObjectId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "channelData": {
    "tenant": { "id": "72f988bf-86f1-41af-91ab-2d7cd011db47" },
    "channel": { "id": "19:xxxxxxxxxx@thread.tacv2" },  // Only for channels
    "team": { "id": "19:xxxxxxxxxx@thread.tacv2" }      // Only for channels
  }
}
```

**Canonical Conversation Key:**
- Primary: `conversation.id` (stable across messages)
- For channels: Combine `channelData.channel.id` + `conversation.tenantId`
- For personal: Use `conversation.id` directly

### 5. Authentication & Verification

**Azure Bot Service:**
- JWT token in `Authorization` header
- Issued by login.microsoftonline.com
- Audience = bot's Microsoft App ID
- Signature verification required

**Implementation:**
```typescript
import { JwtTokenValidation } from 'botframework-connector';

const claims = await JwtTokenValidation.authenticateRequest(
  activity,
  authHeader,
  credentialProvider
);
```

### 6. Required Azure Setup (User/Admin)

#### Minimum Setup
1. **Azure Bot Registration**
   - Create Bot Channels Registration in Azure Portal
   - Get Microsoft App ID and Password
   - Configure messaging endpoint to Fabric

2. **Teams Channel Enablement**
   - Enable Teams channel in Bot Channels Registration
   - No Teams admin approval needed for tenant

3. **Microsoft Graph Integration** (already exists)
   - For token refresh and advanced operations
   - OAuth flow already in Fabric

#### Optional Setup
- **Bot Framework Adapter** (if using SDK)
- **Application Insights** for logging

### 7. Environment Variables

```bash
# Azure Bot Service (new)
MICROSOFT_BOT_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_BOT_APP_PASSWORD=xxxxxxxxxxxxxxxxxxxx
MICROSOFT_BOT_APP_TYPE=MultiTenant
MICROSOFT_BOT_TENANT_ID=common

# Graph API (existing - for fallback/tooling)
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxx
MICROSOFT_TENANT_ID=common
```

### 8. Activity Types to Handle

| Activity Type | When Received | Action |
|--------------|---------------|--------|
| `message` | User sends message/mention | Process and reply |
| `conversationUpdate` | User added/removed from conversation | Track conversation state |
| `typing` | User is typing | Optional: trigger proactive |
| `invoke` | Card action clicked | Handle button interactions |

### 9. Message Content Format

**Plain Text:**
```json
{
  "text": "Hello @Fabric can you help?",
  "textFormat": "plain"
}
```

**HTML (when rich text):**
```json
{
  "text": "Hello <at>User</at> can you help?",
  "textFormat": "xml"
}
```

**Mention stripping required:** Similar to Slack, need to remove `<at>Bot Name</at>` tags.

### 10. Minimum Viable Teams v1

**In Scope:**
- ✅ Personal chat with bot
- ✅ Group chat mentions
- ✅ Channel @mentions
- ✅ Reply in same conversation context
- ✅ 24h conversation timeout (same as Slack)
- ✅ Plain text responses

**Out of Scope (v1):**
- ❌ Adaptive Cards / rich formatting
- ❌ File attachments
- ❌ Proactive messages (sending without trigger)
- ❌ Channel-wide notifications (outside @mention)
- ❌ Tab apps / task modules

---

## Architecture Recommendation

### Verified Path: Azure Bot Service

**Rationale:**
- Only option supporting personal/group chats
- Official Microsoft-supported integration
- Aligns with Fabric's existing OAuth/Graph infrastructure
- Provides best UX parity with Slack implementation

### Implementation Complexity

| Component | Effort | Notes |
|-----------|--------|-------|
| Azure Bot setup docs | 1 day | User/admin guide |
| Database schema (T1) | 1 day | Similar to Slack |
| Bot endpoint (T2) | 2-3 days | JWT auth, activity parsing |
| Conversation activities (T3) | 2 days | Similar to Slack pattern |
| Workflow routing (T4) | 2 days | Reuse Slack patterns |
| UI config (T5) | 1-2 days | Add to TriggersSheet |
| Testing | 2 days | Azure environment needed |

**Total estimated effort:** 10-12 days

### Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Azure Bot setup friction | High | Clear setup guide, validate with early users |
| Teams admin approval | Medium | Bot doesn't require tenant admin approval |
| Rate limiting | Low | Bot Framework handles throttling |
| Conversation ID format changes | Low | Use Bot Framework SDK abstractions |

---

## Decision Required

### Option 1: Proceed with Full Implementation (T1-T5)
**If:** Teams conversational parity is high priority, Azure setup acceptable

### Option 2: Defer Teams, Prioritize Other Gaps
**If:** Teams setup complexity is too high, focus on inline comments / code intelligence

### Option 3: Hybrid - Document-Only Setup Guide First
**If:** Want to validate user demand before implementation

---

## Recommended Next Steps

1. **Validate Azure Bot setup complexity**
   - Create test bot registration
   - Verify endpoint receives activities
   - Document exact steps for users

2. **Decision point**
   - If setup is acceptable: Proceed T1-T5
   - If setup is too complex: Defer to post-launch

3. **Parallel work**
   - Complete B5 Slack UI polish
   - Proceed with code intelligence / workspace Q&A
   - Revisit Teams after other P1 gaps closed

---

## Feasibility Verdict

**Is Teams conversational parity technically feasible?** ✅ YES

**Is it the right priority now?** ⚠️ DEPENDS

Teams requires Azure infrastructure commitment. Slack implementation is already complete and validated. Consider completing other P1 gaps (inline comments, code intelligence) before committing to Teams 10-12 day implementation.

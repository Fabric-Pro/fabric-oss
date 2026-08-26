# Slack Integration Setup

## Required Environment Variables

```bash
# Slack Events API signature verification
SLACK_SIGNING_SECRET=your-slack-signing-secret

# Optional: Slack app credentials (if not using integration connection flow)
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
```

## Required Bot Token Scopes

Declare these under **OAuth & Permissions > Bot Token Scopes** in the Slack app
configuration. They must be present in the app *before* anyone connects, or the
install can be rejected for every Slack connection — not just the feature that
needs a given scope.

| Scope | Needed for |
|-------|-----------|
| `channels:read`, `groups:read` | Listing channels in the pickers |
| `channels:history`, `groups:history` | Reading monitored-channel messages |
| `users:read`, `users:read.email` | Resolving message authors |
| `chat:write` | Posting messages and thread replies |
| `chat:write.public` | Posting to a **public** channel the bot has not joined |
| `channels:join` | Joining a public channel so delivery can self-heal |
| `reactions:write` | Acknowledging with reactions |
| `files:read`, `canvases:read` | Huddle-notes ingestion |

`chat:write` alone is not sufficient to post to an arbitrary channel: Slack
returns `not_in_channel` for any channel the bot is not a member of. Release
Notes chat delivery therefore needs `chat:write.public` (public channels) plus
`channels:join` (so it can join and retry). **Private channels can never be
self-served — the app must be invited to them manually.**

Changing this list requires re-authorizing Slack; existing tokens keep the
scopes they were granted at install time. Workspaces connected with a pasted
bot token must reinstall the app and replace the stored token.

## How It Works

### Thread Continuity
When someone mentions @Fabric in a Slack channel:
1. Fabric replies back into the **same thread**
2. The conversation continues until the timeout expires (default: 24 hours)
3. New mentions in the same thread continue the same Fabric conversation

### Direct Messages
Fabric can optionally respond to direct messages. Enable this in the trigger configuration.

### Safety Features
- **Duplicate protection**: Same Slack event is never processed twice
- **Timeout handling**: Inactive threads automatically start fresh conversations
- **Signature verification**: All Slack requests are cryptographically verified

## Configuration Options

In your agent's **Triggers > Slack** settings:

| Setting | Description | Default |
|---------|-------------|---------|
| Reply in Slack threads | Post responses back into the thread | Enabled |
| Keep conversations active for | How long to continue the same thread | 24 hours |
| Respond to @Fabric mentions | Trigger on channel mentions | Enabled |
| Respond to direct messages | Trigger on DMs | Enabled |

## Bot Token Resolution

Slack credentials are resolved from your **Integration Connection** (Settings > Integrations):
- Bot tokens are stored per-workspace
- Tenant isolation enforced (personal vs organization)
- No tokens stored in deployment/trigger configs

## Troubleshooting

### Events not received
- Verify `SLACK_SIGNING_SECRET` is set
- Check Slack app's **Event Subscriptions** URL points to:
  `https://your-domain.com/api/webhooks/slack/events`
- Ensure bot is invited to the channel

### No replies in thread
- Check "Reply in Slack threads" is enabled
- Verify bot has `chat:write` scope
- Check logs for credential errors

### Duplicate responses
- This should not happen (idempotency protection)
- Check `slack_event_receipt` table for duplicates
- Verify event_id is being sent by Slack

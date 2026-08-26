-- Migrate legacy `type='SLACK'` triggers to the unified `CHANNEL_MESSAGE` shape.
--
-- Slice 5b.2 (PR #856, 2026-05-11) moved Slack onto the ChannelAdapter pipeline.
-- Both readers — `apps/web/lib/channels/inbound-handler.ts` and
-- `packages/temporal/src/activities/trigger-system/index.ts` — filter on
-- `type = 'CHANNEL_MESSAGE'` and `config->>'channel'`. The write path was not
-- updated, so every existing Slack trigger has been an orphan since that PR
-- shipped: inbound mentions verify, dedup, and persist a thread mapping, but
-- never dispatch a workflow (the no-trigger branch fires).
--
-- This migration flips legacy rows in place. The `slackChannelId` /
-- `slackTeamId` columns are preserved both for back-compat and because the
-- new `chatIdPattern` is derived from them. The matcher tests
-- `message.channelId` (shape: `${teamId}/${slackChannelId}`) against the
-- pattern, so we anchor with `^` and add `$` only when a specific channel
-- was bound (team-only scoping uses a prefix match).

-- teamId is the tenant boundary for Slack. A legacy row missing
-- `slackTeamId` cannot be safely scoped (channel IDs alone do not delimit
-- workspaces) so we deactivate it; the operator must reconfigure it before
-- it fires. Properly-scoped rows keep their existing isActive value.
UPDATE agent_deployment_trigger
SET type = 'CHANNEL_MESSAGE',
    "isActive" = CASE
                   WHEN "slackTeamId" IS NULL OR "slackTeamId" = ''
                     THEN FALSE
                   ELSE "isActive"
                 END,
    config = (
        COALESCE(config, '{}'::jsonb)
        || jsonb_build_object('channel', 'slack')
        || CASE
             WHEN "slackTeamId" IS NOT NULL
                  AND "slackTeamId" <> ''
                  AND "slackChannelId" IS NOT NULL
                  AND "slackChannelId" <> ''
               THEN jsonb_build_object(
                      'chatIdPattern',
                      '^' || "slackTeamId" || '/' || "slackChannelId" || '$'
                    )
             WHEN "slackTeamId" IS NOT NULL AND "slackTeamId" <> ''
               THEN jsonb_build_object(
                      'chatIdPattern',
                      '^' || "slackTeamId" || '/'
                    )
             ELSE '{}'::jsonb
           END
    )
WHERE type = 'SLACK';

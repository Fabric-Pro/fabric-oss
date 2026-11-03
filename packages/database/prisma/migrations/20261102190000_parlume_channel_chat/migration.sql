ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "meetingUrl" TEXT,
  ADD COLUMN "channelChatStatus" TEXT NOT NULL DEFAULT 'ATTENDEE',
  ADD COLUMN "channelChatError" TEXT,
  ADD COLUMN "channelIntegrationId" TEXT,
  ADD COLUMN "channelTeamId" TEXT,
  ADD COLUMN "channelId" TEXT,
  ADD COLUMN "channelRootMessageId" TEXT,
  ADD COLUMN "channelTenantId" TEXT,
  ADD COLUMN "channelSubscriptionId" TEXT,
  ADD COLUMN "channelSubscriptionExpiresAt" TIMESTAMP(3);

CREATE TABLE "parlume_channel_post" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "parlume_channel_post_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "parlume_channel_post_sessionId_fkey" FOREIGN KEY ("sessionId")
    REFERENCES "parlume_meeting_session"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "parlume_channel_post_sessionId_tag_key" ON "parlume_channel_post"("sessionId", "tag");
CREATE INDEX "parlume_channel_post_projectId_idx" ON "parlume_channel_post"("projectId");
CREATE INDEX "parlume_channel_post_organizationId_idx" ON "parlume_channel_post"("organizationId");

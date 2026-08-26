-- AlterEnum: passive AI-Updates context type for Slack huddle AI-notes canvases
ALTER TYPE "ProjectContextType" ADD VALUE 'SLACK_HUDDLE_NOTES';

-- AlterTable: forward-only, poll-based Slack huddle notes ingestion settings on the project
-- (independent of the event-driven slackChannelMonitor columns; all additive + nullable/default-off)
ALTER TABLE "project" ADD COLUMN "slackHuddleIngestEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project" ADD COLUMN "slackHuddleIngestEnabledAt" TIMESTAMP(3);
ALTER TABLE "project" ADD COLUMN "slackHuddleIngestIntervalMin" INTEGER;
ALTER TABLE "project" ADD COLUMN "slackHuddleIngestLastRun" TIMESTAMP(3);
ALTER TABLE "project" ADD COLUMN "slackHuddleIngestWorkflowId" TEXT;

-- CreateTable: tracking row for auto-synced huddle AI-notes canvases (canvas-id dedup anchor)
CREATE TABLE "project_slack_huddle_note" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkedChannelId" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "huddleTranscriptFileId" TEXT,
    "huddleSummaryId" TEXT,
    "huddleDateStart" TIMESTAMP(3),
    "huddleDateEnd" TIMESTAMP(3),
    "title" TEXT,
    "contextId" TEXT,
    "contentHash" TEXT,
    "contentLength" INTEGER,
    "wasSummarized" BOOLEAN NOT NULL DEFAULT false,
    "speakerNames" TEXT[],
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_slack_huddle_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_slack_huddle_note_projectId_idx" ON "project_slack_huddle_note"("projectId");

-- CreateIndex
CREATE INDEX "project_slack_huddle_note_linkedChannelId_idx" ON "project_slack_huddle_note"("linkedChannelId");

-- CreateIndex
CREATE INDEX "project_slack_huddle_note_huddleDateStart_idx" ON "project_slack_huddle_note"("huddleDateStart");

-- CreateIndex
CREATE UNIQUE INDEX "project_slack_huddle_note_projectId_canvasId_key" ON "project_slack_huddle_note"("projectId", "canvasId");

-- AddForeignKey
ALTER TABLE "project_slack_huddle_note" ADD CONSTRAINT "project_slack_huddle_note_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_slack_huddle_note" ADD CONSTRAINT "project_slack_huddle_note_linkedChannelId_fkey" FOREIGN KEY ("linkedChannelId") REFERENCES "project_linked_slack_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_slack_huddle_note" ADD CONSTRAINT "project_slack_huddle_note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_slack_huddle_note" ADD CONSTRAINT "project_slack_huddle_note_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

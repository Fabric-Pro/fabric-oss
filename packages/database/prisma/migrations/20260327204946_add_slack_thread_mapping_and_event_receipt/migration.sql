-- CreateTable
CREATE TABLE "slack_thread_mapping" (
    "id" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "slackThreadTs" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "triggerId" TEXT,
    "workflowId" TEXT,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastMessageTs" TEXT,
    "timeoutAt" TIMESTAMP(3),
    "contextJson" JSONB,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_thread_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_event_receipt" (
    "id" TEXT NOT NULL,
    "slackEventId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackChannelId" TEXT,
    "slackMessageTs" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT,
    "userId" TEXT,

    CONSTRAINT "slack_event_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slack_thread_mapping_deploymentId_idx" ON "slack_thread_mapping"("deploymentId");

-- CreateIndex
CREATE INDEX "slack_thread_mapping_workflowId_idx" ON "slack_thread_mapping"("workflowId");

-- CreateIndex
CREATE INDEX "slack_thread_mapping_conversationId_idx" ON "slack_thread_mapping"("conversationId");

-- CreateIndex
CREATE INDEX "slack_thread_mapping_status_idx" ON "slack_thread_mapping"("status");

-- CreateIndex
CREATE INDEX "slack_thread_mapping_userId_idx" ON "slack_thread_mapping"("userId");

-- CreateIndex
CREATE INDEX "slack_thread_mapping_organizationId_idx" ON "slack_thread_mapping"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_thread_mapping_slackTeamId_slackChannelId_slackThread_key" ON "slack_thread_mapping"("slackTeamId", "slackChannelId", "slackThreadTs");

-- CreateIndex
CREATE UNIQUE INDEX "slack_event_receipt_slackEventId_key" ON "slack_event_receipt"("slackEventId");

-- CreateIndex
CREATE INDEX "slack_event_receipt_slackTeamId_idx" ON "slack_event_receipt"("slackTeamId");

-- CreateIndex
CREATE INDEX "slack_event_receipt_slackEventId_idx" ON "slack_event_receipt"("slackEventId");

-- CreateIndex
CREATE INDEX "slack_event_receipt_userId_idx" ON "slack_event_receipt"("userId");

-- CreateIndex
CREATE INDEX "slack_event_receipt_organizationId_idx" ON "slack_event_receipt"("organizationId");

-- AddForeignKey
ALTER TABLE "slack_thread_mapping" ADD CONSTRAINT "slack_thread_mapping_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "agent_deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_thread_mapping" ADD CONSTRAINT "slack_thread_mapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_thread_mapping" ADD CONSTRAINT "slack_thread_mapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_event_receipt" ADD CONSTRAINT "slack_event_receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_event_receipt" ADD CONSTRAINT "slack_event_receipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

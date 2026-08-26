-- AlterEnum
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'TELEGRAM';

-- CreateTable
CREATE TABLE "channel_event_receipt" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_event_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_thread_mapping" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "workflowId" TEXT,
    "agentId" TEXT,
    "triggerId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "timeoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_thread_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_event_receipt_channel_idx" ON "channel_event_receipt"("channel");

-- CreateIndex
CREATE INDEX "channel_event_receipt_receivedAt_idx" ON "channel_event_receipt"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "channel_event_receipt_channel_externalEventId_key" ON "channel_event_receipt"("channel", "externalEventId");

-- CreateIndex
CREATE INDEX "channel_thread_mapping_userId_idx" ON "channel_thread_mapping"("userId");

-- CreateIndex
CREATE INDEX "channel_thread_mapping_organizationId_idx" ON "channel_thread_mapping"("organizationId");

-- CreateIndex
CREATE INDEX "channel_thread_mapping_status_idx" ON "channel_thread_mapping"("status");

-- CreateIndex
CREATE INDEX "channel_thread_mapping_workflowId_idx" ON "channel_thread_mapping"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_thread_mapping_channel_channelId_threadId_key" ON "channel_thread_mapping"("channel", "channelId", "threadId");

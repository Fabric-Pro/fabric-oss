-- CreateTable
CREATE TABLE "teams_event_receipt" (
    "id" TEXT NOT NULL,
    "teamsEventId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "teamId" TEXT,
    "messageId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "teams_event_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_event_receipt_teamsEventId_key" ON "teams_event_receipt"("teamsEventId");

-- CreateIndex
CREATE INDEX "teams_event_receipt_channelId_receivedAt_idx" ON "teams_event_receipt"("channelId", "receivedAt");

-- CreateIndex
CREATE INDEX "teams_event_receipt_teamsEventId_idx" ON "teams_event_receipt"("teamsEventId");

-- CreateIndex
CREATE INDEX "teams_event_receipt_userId_idx" ON "teams_event_receipt"("userId");

-- CreateIndex
CREATE INDEX "teams_event_receipt_organizationId_idx" ON "teams_event_receipt"("organizationId");

-- AddForeignKey
ALTER TABLE "teams_event_receipt" ADD CONSTRAINT "teams_event_receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams_event_receipt" ADD CONSTRAINT "teams_event_receipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

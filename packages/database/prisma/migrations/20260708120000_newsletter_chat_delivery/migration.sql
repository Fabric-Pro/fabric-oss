-- AlterTable: newsletter_settings — delivery destination + chat targets
ALTER TABLE "newsletter_settings" ADD COLUMN "deliveryDestination" TEXT NOT NULL DEFAULT 'EMAIL';
ALTER TABLE "newsletter_settings" ADD COLUMN "chatChannels" JSONB;

-- AlterTable: newsletter_send — effective destination for the send
ALTER TABLE "newsletter_send" ADD COLUMN "deliveryDestination" TEXT;

-- CreateTable: per-channel chat delivery ledger
CREATE TABLE "newsletter_chat_delivery" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "platform" TEXT NOT NULL,
    "externalTeamId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "postedMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_chat_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_chat_delivery_send_channel_key" ON "newsletter_chat_delivery"("sendId", "platform", "externalTeamId", "channelId");
CREATE INDEX "newsletter_chat_delivery_sendId_idx" ON "newsletter_chat_delivery"("sendId");
CREATE INDEX "newsletter_chat_delivery_userId_idx" ON "newsletter_chat_delivery"("userId");
CREATE INDEX "newsletter_chat_delivery_organizationId_idx" ON "newsletter_chat_delivery"("organizationId");

-- AddForeignKey
ALTER TABLE "newsletter_chat_delivery" ADD CONSTRAINT "newsletter_chat_delivery_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "newsletter_send"("id") ON DELETE CASCADE ON UPDATE CASCADE;

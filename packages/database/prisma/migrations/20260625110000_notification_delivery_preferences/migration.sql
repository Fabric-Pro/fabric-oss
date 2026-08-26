-- CreateTable
CREATE TABLE "notification_delivery_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '',
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "encryptedWebhookUrl" TEXT,
    "encryptedWebhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_delivery_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_delivery_preference_userId_idx" ON "notification_delivery_preference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_preference_userId_organizationId_key" ON "notification_delivery_preference"("userId", "organizationId");

-- AddForeignKey
ALTER TABLE "notification_delivery_preference" ADD CONSTRAINT "notification_delivery_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

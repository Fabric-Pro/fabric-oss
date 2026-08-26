-- CreateTable
CREATE TABLE "release_notification_settings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "releaseNotesMode" TEXT NOT NULL DEFAULT 'fabric_then_github',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "release_notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_notification_webhook" (
    "id" TEXT NOT NULL,
    "settingsId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "platform" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encryptedUrl" TEXT NOT NULL,
    "urlHint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "release_notification_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_notification_send" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha" TEXT,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "releaseNotesUrl" TEXT,
    "releaseNotesKind" TEXT,
    "message" TEXT,
    "temporalWorkflowId" TEXT,
    "triggeredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "release_notification_send_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_notification_delivery" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "release_notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "release_notification_settings_projectId_key" ON "release_notification_settings"("projectId");

-- CreateIndex
CREATE INDEX "release_notification_settings_userId_idx" ON "release_notification_settings"("userId");

-- CreateIndex
CREATE INDEX "release_notification_settings_organizationId_idx" ON "release_notification_settings"("organizationId");

-- CreateIndex
CREATE INDEX "release_notification_settings_enabled_idx" ON "release_notification_settings"("enabled");

-- CreateIndex
CREATE INDEX "release_notification_webhook_settingsId_idx" ON "release_notification_webhook"("settingsId");

-- CreateIndex
CREATE INDEX "release_notification_webhook_projectId_idx" ON "release_notification_webhook"("projectId");

-- CreateIndex
CREATE INDEX "release_notification_webhook_userId_idx" ON "release_notification_webhook"("userId");

-- CreateIndex
CREATE INDEX "release_notification_webhook_organizationId_idx" ON "release_notification_webhook"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "release_notification_send_idempotencyKey_key" ON "release_notification_send"("idempotencyKey");

-- CreateIndex
CREATE INDEX "release_notification_send_projectId_createdAt_idx" ON "release_notification_send"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "release_notification_send_userId_idx" ON "release_notification_send"("userId");

-- CreateIndex
CREATE INDEX "release_notification_send_organizationId_idx" ON "release_notification_send"("organizationId");

-- CreateIndex
CREATE INDEX "release_notification_delivery_sendId_idx" ON "release_notification_delivery"("sendId");

-- CreateIndex
CREATE INDEX "release_notification_delivery_userId_idx" ON "release_notification_delivery"("userId");

-- CreateIndex
CREATE INDEX "release_notification_delivery_organizationId_idx" ON "release_notification_delivery"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "release_notification_delivery_sendId_webhookId_key" ON "release_notification_delivery"("sendId", "webhookId");

-- AddForeignKey
ALTER TABLE "release_notification_settings" ADD CONSTRAINT "release_notification_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_settings" ADD CONSTRAINT "release_notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_settings" ADD CONSTRAINT "release_notification_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_webhook" ADD CONSTRAINT "release_notification_webhook_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "release_notification_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_webhook" ADD CONSTRAINT "release_notification_webhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_webhook" ADD CONSTRAINT "release_notification_webhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_webhook" ADD CONSTRAINT "release_notification_webhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_send" ADD CONSTRAINT "release_notification_send_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_send" ADD CONSTRAINT "release_notification_send_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_send" ADD CONSTRAINT "release_notification_send_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_delivery" ADD CONSTRAINT "release_notification_delivery_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "release_notification_send"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_delivery" ADD CONSTRAINT "release_notification_delivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "release_notification_webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_delivery" ADD CONSTRAINT "release_notification_delivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_delivery" ADD CONSTRAINT "release_notification_delivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_notification_delivery" ADD CONSTRAINT "release_notification_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


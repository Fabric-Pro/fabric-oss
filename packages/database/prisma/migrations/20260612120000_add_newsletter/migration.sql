-- CreateTable
CREATE TABLE "newsletter_settings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cadence" TEXT NOT NULL DEFAULT 'WEEKLY',
    "dayOfWeek" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "sendHourUtc" INTEGER NOT NULL DEFAULT 9,
    "lastSentAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscriber" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "unsubscribeToken" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_send" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "timeWindowStart" TIMESTAMP(3) NOT NULL,
    "timeWindowEnd" TIMESTAMP(3) NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB,
    "aiUsageTokens" INTEGER,
    "temporalWorkflowId" TEXT,
    "errorMessage" TEXT,
    "triggeredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_send_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_delivery" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_settings_projectId_key" ON "newsletter_settings"("projectId");

-- CreateIndex
CREATE INDEX "newsletter_settings_userId_idx" ON "newsletter_settings"("userId");

-- CreateIndex
CREATE INDEX "newsletter_settings_organizationId_idx" ON "newsletter_settings"("organizationId");

-- CreateIndex
CREATE INDEX "newsletter_settings_enabled_idx" ON "newsletter_settings"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriber_unsubscribeToken_key" ON "newsletter_subscriber"("unsubscribeToken");

-- CreateIndex
CREATE INDEX "newsletter_subscriber_projectId_status_idx" ON "newsletter_subscriber"("projectId", "status");

-- CreateIndex
CREATE INDEX "newsletter_subscriber_userId_idx" ON "newsletter_subscriber"("userId");

-- CreateIndex
CREATE INDEX "newsletter_subscriber_organizationId_idx" ON "newsletter_subscriber"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriber_projectId_email_key" ON "newsletter_subscriber"("projectId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_send_dedupeKey_key" ON "newsletter_send"("dedupeKey");

-- CreateIndex
CREATE INDEX "newsletter_send_projectId_createdAt_idx" ON "newsletter_send"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "newsletter_send_userId_idx" ON "newsletter_send"("userId");

-- CreateIndex
CREATE INDEX "newsletter_send_organizationId_idx" ON "newsletter_send"("organizationId");

-- CreateIndex
CREATE INDEX "newsletter_delivery_sendId_idx" ON "newsletter_delivery"("sendId");

-- CreateIndex
CREATE INDEX "newsletter_delivery_userId_idx" ON "newsletter_delivery"("userId");

-- CreateIndex
CREATE INDEX "newsletter_delivery_organizationId_idx" ON "newsletter_delivery"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_delivery_sendId_recipientEmail_key" ON "newsletter_delivery"("sendId", "recipientEmail");

-- AddForeignKey
ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscriber" ADD CONSTRAINT "newsletter_subscriber_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscriber" ADD CONSTRAINT "newsletter_subscriber_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscriber" ADD CONSTRAINT "newsletter_subscriber_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_send" ADD CONSTRAINT "newsletter_send_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_send" ADD CONSTRAINT "newsletter_send_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_send" ADD CONSTRAINT "newsletter_send_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_delivery" ADD CONSTRAINT "newsletter_delivery_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "newsletter_send"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_delivery" ADD CONSTRAINT "newsletter_delivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_delivery" ADD CONSTRAINT "newsletter_delivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_delivery" ADD CONSTRAINT "newsletter_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One in-flight (PENDING) newsletter send per project. A second send while one is
-- in flight hits this constraint; the oRPC/dispatch path reads back the active row.
CREATE UNIQUE INDEX "newsletter_send_active" ON "newsletter_send"("projectId") WHERE "status" = 'PENDING';

-- CreateTable
CREATE TABLE "integration_approval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "pluginSlug" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "integration_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_approval_userId_idx" ON "integration_approval"("userId");

-- CreateIndex
CREATE INDEX "integration_approval_organizationId_idx" ON "integration_approval"("organizationId");

-- CreateIndex
CREATE INDEX "integration_approval_status_idx" ON "integration_approval"("status");

-- CreateIndex
CREATE INDEX "integration_approval_pluginSlug_idx" ON "integration_approval"("pluginSlug");

-- CreateIndex
CREATE INDEX "integration_approval_expiresAt_idx" ON "integration_approval"("expiresAt");

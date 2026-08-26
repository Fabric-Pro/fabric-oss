-- AlterTable
ALTER TABLE "agent_template_instance" ADD COLUMN     "apiConfig" JSONB,
ADD COLUMN     "isApiExposed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "external_api_usage_log" (
    "id" TEXT NOT NULL,
    "apiKeyType" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "instanceId" TEXT,
    "deploymentId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "executionId" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DECIMAL(10,6),
    "clientIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_api_usage_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_api_usage_log_apiKeyId_idx" ON "external_api_usage_log"("apiKeyId");

-- CreateIndex
CREATE INDEX "external_api_usage_log_apiKeyType_apiKeyId_idx" ON "external_api_usage_log"("apiKeyType", "apiKeyId");

-- CreateIndex
CREATE INDEX "external_api_usage_log_instanceId_idx" ON "external_api_usage_log"("instanceId");

-- CreateIndex
CREATE INDEX "external_api_usage_log_deploymentId_idx" ON "external_api_usage_log"("deploymentId");

-- CreateIndex
CREATE INDEX "external_api_usage_log_userId_idx" ON "external_api_usage_log"("userId");

-- CreateIndex
CREATE INDEX "external_api_usage_log_organizationId_idx" ON "external_api_usage_log"("organizationId");

-- CreateIndex
CREATE INDEX "external_api_usage_log_createdAt_idx" ON "external_api_usage_log"("createdAt");

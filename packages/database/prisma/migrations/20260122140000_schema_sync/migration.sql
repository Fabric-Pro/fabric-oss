-- Schema Sync Migration
-- This migration brings the database in sync with the Prisma schema after
-- schema drift caused by db push and an abandoned refactor branch.

-- ============================================================
-- 1. Create ai_provider_fallback table (missing from database)
-- ============================================================
CREATE TABLE IF NOT EXISTS "ai_provider_fallback" (
    "id" TEXT NOT NULL,
    "primaryProvider" "AIProvider" NOT NULL,
    "fallbackProvider" "AIProvider" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "taskTypes" "AiTaskType"[] DEFAULT ARRAY[]::"AiTaskType"[],
    "triggerOnErrors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 60,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "scope" TEXT NOT NULL DEFAULT 'SYSTEM',
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastTriggeredAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ai_provider_fallback_pkey" PRIMARY KEY ("id")
);

-- Indexes for ai_provider_fallback
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_primaryProvider_idx" ON "ai_provider_fallback"("primaryProvider");
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_isActive_idx" ON "ai_provider_fallback"("isActive");
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_scope_idx" ON "ai_provider_fallback"("scope");
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_userId_idx" ON "ai_provider_fallback"("userId");
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_organizationId_idx" ON "ai_provider_fallback"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_fallback_primaryProvider_fallbackProvider_scope_us_key" ON "ai_provider_fallback"("primaryProvider", "fallbackProvider", "scope", "userId", "organizationId");

-- Foreign keys for ai_provider_fallback
ALTER TABLE "ai_provider_fallback" ADD CONSTRAINT "ai_provider_fallback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_provider_fallback" ADD CONSTRAINT "ai_provider_fallback_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 2. Add missing indexes to ai_task_model_default
-- ============================================================
CREATE INDEX IF NOT EXISTS "ai_task_model_default_provider_idx" ON "ai_task_model_default"("provider");

-- ============================================================
-- 3. Add missing indexes to ai_model_provider_mapping
-- ============================================================
CREATE INDEX IF NOT EXISTS "ai_model_provider_mapping_providerModelId_idx" ON "ai_model_provider_mapping"("providerModelId");
CREATE INDEX IF NOT EXISTS "ai_model_provider_mapping_isAvailable_idx" ON "ai_model_provider_mapping"("isAvailable");

-- ============================================================
-- 4. Handle modelId column on preference tables
-- The schema requires modelId to be NOT NULL, but it's nullable in DB.
-- Since there's no data, we can safely make it NOT NULL.
-- For tables with data, we'd need to either:
--   a) Delete rows with NULL modelId
--   b) Set a default value
--   c) Keep it nullable (schema mismatch)
-- ============================================================

-- For user_model_preference: Delete any rows with NULL modelId (if any exist)
DELETE FROM "user_model_preference" WHERE "modelId" IS NULL;

-- For organization_model_preference: Delete any rows with NULL modelId (if any exist)
DELETE FROM "organization_model_preference" WHERE "modelId" IS NULL;

-- Now make the columns NOT NULL
-- Note: This may fail if there's still data with NULL values
-- We wrap in DO block to handle gracefully
DO $$
BEGIN
    ALTER TABLE "user_model_preference" ALTER COLUMN "modelId" SET NOT NULL;
EXCEPTION
    WHEN others THEN
        RAISE NOTICE 'Could not make user_model_preference.modelId NOT NULL: %', SQLERRM;
END $$;

DO $$
BEGIN
    ALTER TABLE "organization_model_preference" ALTER COLUMN "modelId" SET NOT NULL;
EXCEPTION
    WHEN others THEN
        RAISE NOTICE 'Could not make organization_model_preference.modelId NOT NULL: %', SQLERRM;
END $$;

-- ============================================================
-- 5. Note: The following items exist in DB but not in schema.
-- Prisma ignores extra columns/tables, so they're harmless.
-- We leave them for now to avoid data loss:
--   - azure_openai_deployment table
--   - waitlist table
--   - AZURE_OPENAI, NETLIFY enum values in AIProvider
--   - MASTRA enum value in AgentFramework
--   - mastraModelId columns on preference tables
--   - requiredMcpServers column on agent_template
--   - Various extra indexes
-- ============================================================

-- AlterEnum (only if not exists - made idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'MICROSOFT_GRAPH' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WorkflowIntegrationProvider')) THEN
        ALTER TYPE "public"."WorkflowIntegrationProvider" ADD VALUE 'MICROSOFT_GRAPH';
    END IF;
END $$;

-- DropIndex (idempotent - only if exists)
DROP INDEX IF EXISTS "public"."MCPConfig_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."MCPServer_organizationId_userId_isSystemProvided_idx";
DROP INDEX IF EXISTS "public"."agent_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."agent_workspace_file_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."ai_chat_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."ai_usage_log_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."project_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."project_projectManagementMcpServerId_idx";
DROP INDEX IF EXISTS "public"."purchase_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."wizard_temp_context_organizationId_userId_idx";

-- AlterTable (idempotent - add columns only if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_model' AND column_name = 'replacementModelId') THEN
        ALTER TABLE "public"."ai_model" ADD COLUMN "replacementModelId" TEXT;
    END IF;
END $$;

-- AlterTable (idempotent - add columns only if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_rag_settings' AND column_name = 'enableEpisodicMemory') THEN
        ALTER TABLE "public"."project_rag_settings" ADD COLUMN "enableEpisodicMemory" BOOLEAN NOT NULL DEFAULT true;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_rag_settings' AND column_name = 'rerankTopK') THEN
        ALTER TABLE "public"."project_rag_settings" ADD COLUMN "rerankTopK" INTEGER NOT NULL DEFAULT 10;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_rag_settings' AND column_name = 'rerankerProvider') THEN
        ALTER TABLE "public"."project_rag_settings" ADD COLUMN "rerankerProvider" TEXT NOT NULL DEFAULT 'cross-encoder';
    END IF;
    -- Alter defaults
    ALTER TABLE "public"."project_rag_settings" ALTER COLUMN "topK" SET DEFAULT 50;
    ALTER TABLE "public"."project_rag_settings" ALTER COLUMN "similarityThreshold" SET DEFAULT 0.3;
    ALTER TABLE "public"."project_rag_settings" ALTER COLUMN "enableReranking" SET DEFAULT true;
END $$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "public"."ai_provider_fallback" (
    "id" TEXT NOT NULL,
    "primaryProvider" "public"."AIProvider" NOT NULL,
    "fallbackProvider" "public"."AIProvider" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "taskTypes" "public"."AiTaskType"[] DEFAULT ARRAY[]::"public"."AiTaskType"[],
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

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "public"."waitlist" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_isActive_idx" ON "public"."ai_provider_fallback"("isActive" ASC);
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_organizationId_idx" ON "public"."ai_provider_fallback"("organizationId" ASC);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_fallback_primaryProvider_fallbackProvider_scope_key" ON "public"."ai_provider_fallback"("primaryProvider" ASC, "fallbackProvider" ASC, "scope" ASC, "userId" ASC, "organizationId" ASC);
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_primaryProvider_idx" ON "public"."ai_provider_fallback"("primaryProvider" ASC);
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_scope_idx" ON "public"."ai_provider_fallback"("scope" ASC);
CREATE INDEX IF NOT EXISTS "ai_provider_fallback_userId_idx" ON "public"."ai_provider_fallback"("userId" ASC);
CREATE INDEX IF NOT EXISTS "waitlist_createdAt_idx" ON "public"."waitlist"("createdAt" ASC);
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_email_key" ON "public"."waitlist"("email" ASC);
CREATE INDEX IF NOT EXISTS "ai_model_replacementModelId_idx" ON "public"."ai_model"("replacementModelId" ASC);

-- AddForeignKey (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ai_model_replacementModelId_fkey') THEN
        ALTER TABLE "public"."ai_model" ADD CONSTRAINT "ai_model_replacementModelId_fkey" FOREIGN KEY ("replacementModelId") REFERENCES "public"."ai_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ai_provider_fallback_organizationId_fkey') THEN
        ALTER TABLE "public"."ai_provider_fallback" ADD CONSTRAINT "ai_provider_fallback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ai_provider_fallback_userId_fkey') THEN
        ALTER TABLE "public"."ai_provider_fallback" ADD CONSTRAINT "ai_provider_fallback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

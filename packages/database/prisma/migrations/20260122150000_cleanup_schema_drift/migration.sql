-- Cleanup Schema Drift Migration
-- Removes tables, columns, indexes, and enum values that were added via db push
-- but are not in the current schema.prisma. This migration is idempotent.

-- ============================================================
-- 1. Drop azure_openai_deployment table (not in schema)
-- ============================================================
DROP TABLE IF EXISTS "azure_openai_deployment";

-- ============================================================
-- 2. Drop extra columns from ai_model_provider_mapping
-- ============================================================
ALTER TABLE "ai_model_provider_mapping" DROP COLUMN IF EXISTS "contextWindowOverride";
ALTER TABLE "ai_model_provider_mapping" DROP COLUMN IF EXISTS "isDefault";
ALTER TABLE "ai_model_provider_mapping" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "ai_model_provider_mapping" DROP COLUMN IF EXISTS "rateLimitPerMinute";

-- ============================================================
-- 3. Drop extra columns from preference tables
-- ============================================================
ALTER TABLE "user_model_preference" DROP COLUMN IF EXISTS "mastraModelId";
ALTER TABLE "organization_model_preference" DROP COLUMN IF EXISTS "mastraModelId";

-- ============================================================
-- 4. Drop extra column from agent_template
-- ============================================================
ALTER TABLE "agent_template" DROP COLUMN IF EXISTS "requiredMcpServers";

-- ============================================================
-- 5. Drop extra indexes (these were added via db push)
-- Note: Using IF EXISTS where possible, wrapped in DO blocks for safety
-- ============================================================

-- MCPConfig indexes
DROP INDEX IF EXISTS "MCPConfig_organizationId_userId_idx";

-- MCPServer indexes
DROP INDEX IF EXISTS "MCPServer_organizationId_userId_isSystemProvided_idx";

-- agent indexes
DROP INDEX IF EXISTS "agent_organizationId_userId_idx";

-- agent_workspace_file indexes
DROP INDEX IF EXISTS "agent_workspace_file_organizationId_userId_idx";

-- ai_chat indexes
DROP INDEX IF EXISTS "ai_chat_organizationId_userId_idx";

-- ai_model_provider_mapping indexes
DROP INDEX IF EXISTS "ai_model_provider_mapping_modelId_idx";

-- ai_usage_log indexes
DROP INDEX IF EXISTS "ai_usage_log_organizationId_userId_idx";

-- project indexes
DROP INDEX IF EXISTS "project_organizationId_userId_idx";

-- purchase indexes
DROP INDEX IF EXISTS "purchase_organizationId_userId_idx";

-- wizard_temp_context indexes
DROP INDEX IF EXISTS "wizard_temp_context_organizationId_userId_idx";

-- ============================================================
-- 6. Remove unused enum values from AIProvider
-- PostgreSQL doesn't support DROP VALUE, so we need to:
-- a) Check if any rows use the values
-- b) Recreate the enum without those values
-- This is complex and risky, so we'll skip enum cleanup for now.
-- The extra enum values are harmless - they just won't be used.
-- ============================================================

-- NOTE: AZURE_OPENAI, NETLIFY enum values are left in place.
-- Removing enum values in PostgreSQL requires recreating the enum type,
-- which involves updating all columns using it. This is risky and
-- the extra values cause no harm.

-- Similarly for AgentFramework.MASTRA - left in place for safety.

-- ============================================================
-- 7. Fix ai_provider_fallback unique index name (truncation issue)
-- ============================================================
-- The index was created with a truncated name. Rename it to the proper name.
DO $$
BEGIN
    -- Check if the truncated index exists and rename it
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ai_provider_fallback_primaryProvider_fallbackProvider_scope_us_') THEN
        ALTER INDEX "ai_provider_fallback_primaryProvider_fallbackProvider_scope_us_"
        RENAME TO "ai_provider_fallback_primaryProvider_fallbackProvider_scope_key";
    END IF;
END $$;

-- Replace MASTRA with COPILOTKIT in AgentFramework enum
-- MASTRA was never used, so no data migration needed

-- Add COPILOTKIT to the enum
ALTER TYPE "AgentFramework" ADD VALUE IF NOT EXISTS 'COPILOTKIT';

-- Note: PostgreSQL doesn't allow removing enum values directly.
-- MASTRA will remain in the enum but is unused.
-- This is safe as no data references it.

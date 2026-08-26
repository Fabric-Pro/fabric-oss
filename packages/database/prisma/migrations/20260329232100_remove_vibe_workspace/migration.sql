-- Remove VIBE_WORKSPACE from CodingRunProvider enum
-- First drop dependent columns' defaults and types
ALTER TABLE "project" ALTER COLUMN "implementationDefaultProvider" DROP DEFAULT;
ALTER TABLE "project" ALTER COLUMN "implementationDefaultProvider" TYPE TEXT;

ALTER TABLE "coding_run" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "coding_run" ALTER COLUMN "provider" TYPE TEXT;

-- Drop and recreate the enum without VIBE_WORKSPACE
DROP TYPE "CodingRunProvider" CASCADE;
CREATE TYPE "CodingRunProvider" AS ENUM ('BACKGROUND_AGENTS', 'KANBAN_LOCAL');

-- Convert columns back to enum
ALTER TABLE "coding_run" ALTER COLUMN "provider" TYPE "CodingRunProvider" USING "provider"::"CodingRunProvider";
ALTER TABLE "coding_run" ALTER COLUMN "provider" SET DEFAULT 'BACKGROUND_AGENTS';

ALTER TABLE "project" ALTER COLUMN "implementationDefaultProvider" TYPE "CodingRunProvider" USING "implementationDefaultProvider"::"CodingRunProvider";

-- Remove WORKSPACE_AGENTS from CodingRunExecutionChannel enum
-- First drop dependent columns' defaults and types
ALTER TABLE "coding_run" ALTER COLUMN "executionChannel" DROP DEFAULT;
ALTER TABLE "coding_run" ALTER COLUMN "executionChannel" TYPE TEXT;

ALTER TABLE "project" ALTER COLUMN "implementationDefaultChannel" TYPE TEXT;

-- Drop and recreate the enum without WORKSPACE_AGENTS
DROP TYPE "CodingRunExecutionChannel" CASCADE;
CREATE TYPE "CodingRunExecutionChannel" AS ENUM ('BACKGROUND_AGENTS', 'LOCAL_AGENTS');

-- Convert columns back to enum
ALTER TABLE "coding_run" ALTER COLUMN "executionChannel" TYPE "CodingRunExecutionChannel" USING "executionChannel"::"CodingRunExecutionChannel";
ALTER TABLE "coding_run" ALTER COLUMN "executionChannel" SET DEFAULT 'BACKGROUND_AGENTS';

ALTER TABLE "project" ALTER COLUMN "implementationDefaultChannel" TYPE "CodingRunExecutionChannel" USING "implementationDefaultChannel"::"CodingRunExecutionChannel";

-- Alter the project table to remove vibe columns
ALTER TABLE "project" DROP COLUMN IF EXISTS "vibeRemoteProjectId";
ALTER TABLE "project" DROP COLUMN IF EXISTS "vibeRemoteProjectName";

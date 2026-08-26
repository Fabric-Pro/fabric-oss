CREATE TYPE "CodingRunExecutionChannel" AS ENUM ('BACKGROUND_AGENTS', 'LOCAL_AGENTS', 'WORKSPACE_AGENTS');

ALTER TYPE "CodingRunProvider" ADD VALUE IF NOT EXISTS 'KANBAN_LOCAL';
ALTER TYPE "CodingRunProvider" ADD VALUE IF NOT EXISTS 'VIBE_WORKSPACE';

ALTER TABLE "coding_run"
  ADD COLUMN "executionChannel" "CodingRunExecutionChannel" NOT NULL DEFAULT 'BACKGROUND_AGENTS',
  ADD COLUMN "providerMetadata" JSONB,
  ADD COLUMN "externalUrl" TEXT,
  ADD COLUMN "externalStatus" TEXT,
  ADD COLUMN "workingDirectory" TEXT;

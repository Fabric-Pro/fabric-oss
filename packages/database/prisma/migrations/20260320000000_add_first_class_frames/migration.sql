-- Add first-class Frame file types
ALTER TYPE "AgentFileType" ADD VALUE IF NOT EXISTS 'FRAME';
ALTER TYPE "AgentFileType" ADD VALUE IF NOT EXISTS 'SLIDESHOW';

-- Add public sharing + provenance fields to agent_workspace_file
ALTER TABLE "agent_workspace_file"
ADD COLUMN IF NOT EXISTS "shareToken" TEXT,
ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "sourceRunType" TEXT,
ADD COLUMN IF NOT EXISTS "sourceRunId" TEXT,
ADD COLUMN IF NOT EXISTS "authoritySessionId" TEXT,
ADD COLUMN IF NOT EXISTS "providerKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS "agent_workspace_file_shareToken_key"
ON "agent_workspace_file"("shareToken");

CREATE INDEX IF NOT EXISTS "agent_workspace_file_shareToken_idx"
ON "agent_workspace_file"("shareToken");

CREATE INDEX IF NOT EXISTS "agent_workspace_file_isPublic_idx"
ON "agent_workspace_file"("isPublic");

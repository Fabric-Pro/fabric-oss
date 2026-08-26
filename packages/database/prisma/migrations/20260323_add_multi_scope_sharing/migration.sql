-- Add FrameShareScope enum type
CREATE TYPE "FrameShareScope" AS ENUM ('PRIVATE', 'EMAILS_ONLY', 'WORKSPACE_AND_EMAILS', 'PUBLIC');

-- Add shareScope column to agent_workspace_file
ALTER TABLE "agent_workspace_file" 
ADD COLUMN "shareScope" "FrameShareScope" NOT NULL DEFAULT 'PRIVATE';

-- Migrate existing data: isPublic=true becomes PUBLIC scope
UPDATE "agent_workspace_file" 
SET "shareScope" = 'PUBLIC' 
WHERE "isPublic" = true;

-- Create FrameSharingGrant table for email-based sharing
CREATE TABLE "frame_sharing_grant" (
    "id" TEXT NOT NULL,
    "frameId" TEXT NOT NULL,
    "email" TEXT,
    "invitedBy" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "frame_sharing_grant_pkey" PRIMARY KEY ("id")
);

-- Create indexes for FrameSharingGrant
CREATE INDEX "frame_sharing_grant_frameId_idx" ON "frame_sharing_grant"("frameId");
CREATE INDEX "frame_sharing_grant_email_idx" ON "frame_sharing_grant"("email");
CREATE UNIQUE INDEX "frame_sharing_grant_frameId_email_key" ON "frame_sharing_grant"("frameId", "email");

-- Add foreign key constraint
ALTER TABLE "frame_sharing_grant" 
ADD CONSTRAINT "frame_sharing_grant_frameId_fkey" 
FOREIGN KEY ("frameId") REFERENCES "agent_workspace_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add index for shareScope lookups
CREATE INDEX "agent_workspace_file_shareScope_idx" ON "agent_workspace_file"("shareScope");

-- CreateEnum
CREATE TYPE "AgentMemoryFileType" AS ENUM ('AGENTS_MD', 'MCP_JSON', 'SKILL', 'KNOWLEDGE', 'CONVERSATION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AgentMemoryEditOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "AgentMemoryEditStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED');

-- AlterTable
ALTER TABLE "agent_template_instance" ADD COLUMN "memoryAutoApprove" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "agent_memory_file" (
    "id" TEXT NOT NULL,
    "agentInstanceId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "path" TEXT NOT NULL,
    "fileType" "AgentMemoryFileType" NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "validationError" TEXT,
    "lastModifiedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_memory_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory_edit" (
    "id" TEXT NOT NULL,
    "memoryFileId" TEXT,
    "agentInstanceId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "operation" "AgentMemoryEditOperation" NOT NULL,
    "path" TEXT NOT NULL,
    "oldContent" TEXT,
    "newContent" TEXT NOT NULL,
    "reason" TEXT,
    "status" "AgentMemoryEditStatus" NOT NULL DEFAULT 'PENDING',
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_edit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestrator_memory_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "responseStyle" TEXT,
    "verbosity" TEXT,
    "codeLanguage" TEXT,
    "timezone" TEXT,
    "language" TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "recentProjectIds" TEXT[],
    "recentWorkspaceIds" TEXT[],
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orchestrator_memory_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episodic_memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "workspaceId" TEXT,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "keyTopics" TEXT[],
    "userIntents" TEXT[],
    "outcome" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "turnCount" INTEGER NOT NULL,
    "toolsUsed" TEXT[],
    "agentsUsed" TEXT[],
    "conversationStartedAt" TIMESTAMP(3) NOT NULL,
    "conversationEndedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qdrantPointId" TEXT,
    "qdrantCollection" TEXT,

    CONSTRAINT "episodic_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_memory_file_agentInstanceId_path_key" ON "agent_memory_file"("agentInstanceId", "path");

-- CreateIndex
CREATE INDEX "agent_memory_file_userId_idx" ON "agent_memory_file"("userId");

-- CreateIndex
CREATE INDEX "agent_memory_file_organizationId_idx" ON "agent_memory_file"("organizationId");

-- CreateIndex
CREATE INDEX "agent_memory_file_fileType_idx" ON "agent_memory_file"("fileType");

-- CreateIndex
CREATE INDEX "agent_memory_file_agentInstanceId_idx" ON "agent_memory_file"("agentInstanceId");

-- CreateIndex
CREATE INDEX "agent_memory_edit_agentInstanceId_status_idx" ON "agent_memory_edit"("agentInstanceId", "status");

-- CreateIndex
CREATE INDEX "agent_memory_edit_userId_idx" ON "agent_memory_edit"("userId");

-- CreateIndex
CREATE INDEX "agent_memory_edit_organizationId_idx" ON "agent_memory_edit"("organizationId");

-- CreateIndex
CREATE INDEX "agent_memory_edit_status_idx" ON "agent_memory_edit"("status");

-- CreateIndex
CREATE INDEX "agent_memory_edit_memoryFileId_idx" ON "agent_memory_edit"("memoryFileId");

-- CreateIndex
CREATE UNIQUE INDEX "orchestrator_memory_preferences_userId_organizationId_key" ON "orchestrator_memory_preferences"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "orchestrator_memory_preferences_userId_idx" ON "orchestrator_memory_preferences"("userId");

-- CreateIndex
CREATE INDEX "orchestrator_memory_preferences_organizationId_idx" ON "orchestrator_memory_preferences"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "episodic_memory_conversationId_key" ON "episodic_memory"("conversationId");

-- CreateIndex
CREATE INDEX "episodic_memory_userId_organizationId_idx" ON "episodic_memory"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "episodic_memory_projectId_idx" ON "episodic_memory"("projectId");

-- CreateIndex
CREATE INDEX "episodic_memory_workspaceId_idx" ON "episodic_memory"("workspaceId");

-- CreateIndex
CREATE INDEX "episodic_memory_conversationEndedAt_idx" ON "episodic_memory"("conversationEndedAt");

-- CreateIndex
CREATE INDEX "episodic_memory_agentId_idx" ON "episodic_memory"("agentId");

-- CreateIndex
CREATE INDEX "episodic_memory_keyTopics_idx" ON "episodic_memory"("keyTopics");

-- CreateIndex
CREATE INDEX "episodic_memory_qdrantPointId_idx" ON "episodic_memory"("qdrantPointId");

-- AddForeignKey
ALTER TABLE "agent_memory_file" ADD CONSTRAINT "agent_memory_file_agentInstanceId_fkey" FOREIGN KEY ("agentInstanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_file" ADD CONSTRAINT "agent_memory_file_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_file" ADD CONSTRAINT "agent_memory_file_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_edit" ADD CONSTRAINT "agent_memory_edit_memoryFileId_fkey" FOREIGN KEY ("memoryFileId") REFERENCES "agent_memory_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_edit" ADD CONSTRAINT "agent_memory_edit_agentInstanceId_fkey" FOREIGN KEY ("agentInstanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_edit" ADD CONSTRAINT "agent_memory_edit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_edit" ADD CONSTRAINT "agent_memory_edit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrator_memory_preferences" ADD CONSTRAINT "orchestrator_memory_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrator_memory_preferences" ADD CONSTRAINT "orchestrator_memory_preferences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodic_memory" ADD CONSTRAINT "episodic_memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodic_memory" ADD CONSTRAINT "episodic_memory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodic_memory" ADD CONSTRAINT "episodic_memory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodic_memory" ADD CONSTRAINT "episodic_memory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

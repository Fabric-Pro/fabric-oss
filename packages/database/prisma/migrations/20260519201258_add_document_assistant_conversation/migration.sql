-- CreateEnum
CREATE TYPE "DocumentRefKind" AS ENUM ('PROJECT_DOCUMENT', 'USER_STORY');

-- CreateEnum
CREATE TYPE "DocumentAssistantVisibility" AS ENUM ('SHARED', 'PRIVATE');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "documentAssistantHistoryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "document_assistant_conversation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "documentRefKind" "DocumentRefKind" NOT NULL,
    "documentRefId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT NOT NULL,
    "visibility" "DocumentAssistantVisibility" NOT NULL DEFAULT 'SHARED',
    "visibilityLockedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_assistant_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_assistant_conversation_conversationId_key" ON "document_assistant_conversation"("conversationId");

-- CreateIndex
CREATE INDEX "document_assistant_conversation_documentRefKind_documentRef_idx" ON "document_assistant_conversation"("documentRefKind", "documentRefId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "document_assistant_conversation_projectId_createdAt_idx" ON "document_assistant_conversation"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "document_assistant_conversation_organizationId_createdAt_idx" ON "document_assistant_conversation"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "document_assistant_conversation_userId_createdAt_idx" ON "document_assistant_conversation"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "document_assistant_conversation_documentRefKind_documentRef_key" ON "document_assistant_conversation"("documentRefKind", "documentRefId", "conversationId");

-- AddForeignKey
ALTER TABLE "document_assistant_conversation" ADD CONSTRAINT "document_assistant_conversation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_assistant_conversation" ADD CONSTRAINT "document_assistant_conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_assistant_conversation" ADD CONSTRAINT "document_assistant_conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_assistant_conversation" ADD CONSTRAINT "document_assistant_conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "BacklogUpdateSessionStatus" AS ENUM ('APPLYING', 'APPLIED', 'PARTIALLY_APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "backlog_update_session" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pendingProposalId" TEXT,
    "conversationId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'AI_UPDATE_SIDEBAR',
    "status" "BacklogUpdateSessionStatus" NOT NULL DEFAULT 'APPLYING',
    "summary" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "createCount" INTEGER NOT NULL DEFAULT 0,
    "updateCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "syncedToPMCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "backlog_update_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backlog_update_session_projectId_createdAt_idx" ON "backlog_update_session"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "backlog_update_session_pendingProposalId_idx" ON "backlog_update_session"("pendingProposalId");

-- CreateIndex
CREATE INDEX "backlog_update_session_userId_idx" ON "backlog_update_session"("userId");

-- CreateIndex
CREATE INDEX "backlog_update_session_organizationId_idx" ON "backlog_update_session"("organizationId");

-- AddForeignKey
ALTER TABLE "backlog_update_session" ADD CONSTRAINT "backlog_update_session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backlog_update_session" ADD CONSTRAINT "backlog_update_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backlog_update_session" ADD CONSTRAINT "backlog_update_session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

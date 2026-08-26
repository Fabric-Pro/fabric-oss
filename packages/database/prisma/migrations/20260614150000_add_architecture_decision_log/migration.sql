-- CreateEnum
CREATE TYPE "architecture_decision_status" AS ENUM ('PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'DEPRECATED');

-- AlterEnum
ALTER TYPE "ProjectContextType" ADD VALUE 'ARCHITECTURE_DECISION';

-- CreateTable
CREATE TABLE "architecture_decision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contextProblem" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "alternativesConsidered" TEXT,
    "status" "architecture_decision_status" NOT NULL DEFAULT 'PROPOSED',
    "decisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "participantUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "participantsText" TEXT,
    "supersededById" TEXT,
    "createdById" TEXT NOT NULL,
    "lastEditedById" TEXT,
    "contextId" TEXT,
    "sourceKind" TEXT,
    "sourceMetadata" JSONB,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "architecture_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture_decision_comment" (
    "id" TEXT NOT NULL,
    "architectureDecisionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorType" "project_comment_author_type" NOT NULL DEFAULT 'USER',
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "architecture_decision_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture_decision_version" (
    "id" TEXT NOT NULL,
    "architectureDecisionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "contextProblem" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "alternativesConsidered" TEXT,
    "status" "architecture_decision_status" NOT NULL,
    "decisionDate" TIMESTAMP(3) NOT NULL,
    "participantUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "participantsText" TEXT,
    "editedById" TEXT NOT NULL,
    "editedByName" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "architecture_decision_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "architecture_decision_projectId_idx" ON "architecture_decision"("projectId");

-- CreateIndex
CREATE INDEX "architecture_decision_userId_idx" ON "architecture_decision"("userId");

-- CreateIndex
CREATE INDEX "architecture_decision_organizationId_idx" ON "architecture_decision"("organizationId");

-- CreateIndex
CREATE INDEX "architecture_decision_projectId_status_idx" ON "architecture_decision"("projectId", "status");

-- CreateIndex
CREATE INDEX "architecture_decision_projectId_deletedAt_idx" ON "architecture_decision"("projectId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "architecture_decision_projectId_identifier_key" ON "architecture_decision"("projectId", "identifier");

-- CreateIndex
CREATE INDEX "architecture_decision_comment_architectureDecisionId_create_idx" ON "architecture_decision_comment"("architectureDecisionId", "createdAt");

-- CreateIndex
CREATE INDEX "architecture_decision_comment_authorId_idx" ON "architecture_decision_comment"("authorId");

-- CreateIndex
CREATE INDEX "architecture_decision_comment_parentId_idx" ON "architecture_decision_comment"("parentId");

-- CreateIndex
CREATE INDEX "architecture_decision_comment_organizationId_idx" ON "architecture_decision_comment"("organizationId");

-- CreateIndex
CREATE INDEX "architecture_decision_version_architectureDecisionId_versio_idx" ON "architecture_decision_version"("architectureDecisionId", "version");

-- CreateIndex
CREATE INDEX "architecture_decision_version_userId_idx" ON "architecture_decision_version"("userId");

-- CreateIndex
CREATE INDEX "architecture_decision_version_organizationId_idx" ON "architecture_decision_version"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "architecture_decision_version_architectureDecisionId_versio_key" ON "architecture_decision_version"("architectureDecisionId", "version");

-- AddForeignKey
ALTER TABLE "architecture_decision" ADD CONSTRAINT "architecture_decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision" ADD CONSTRAINT "architecture_decision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision" ADD CONSTRAINT "architecture_decision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_comment" ADD CONSTRAINT "architecture_decision_comment_architectureDecisionId_fkey" FOREIGN KEY ("architectureDecisionId") REFERENCES "architecture_decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_comment" ADD CONSTRAINT "architecture_decision_comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "architecture_decision_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_comment" ADD CONSTRAINT "architecture_decision_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_comment" ADD CONSTRAINT "architecture_decision_comment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_version" ADD CONSTRAINT "architecture_decision_version_architectureDecisionId_fkey" FOREIGN KEY ("architectureDecisionId") REFERENCES "architecture_decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_version" ADD CONSTRAINT "architecture_decision_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decision_version" ADD CONSTRAINT "architecture_decision_version_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


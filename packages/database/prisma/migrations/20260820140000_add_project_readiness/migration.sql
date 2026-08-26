-- Project readiness checklist (Fizzy #2165).
--
-- Adds the two project-level fields the checklist is graded against, the
-- classification a link context source needs to satisfy the Knowledge Base item,
-- and the two tables that hold what cannot be derived.
--
-- Completion is deliberately NOT stored: it is computed from live project state
-- on every read, so it cannot drift from reality. Only manual states and the
-- previous verdict are persisted.
--
-- No index is added to an existing table, so this migration needs no
-- CONCURRENTLY split.

-- CreateEnum
CREATE TYPE "ProjectPhase" AS ENUM ('DISCOVERY_PLANNING', 'DEVELOPMENT_EXECUTION');

-- CreateEnum
CREATE TYPE "KnowledgeBaseSourceCategory" AS ENUM ('KNOWLEDGE_BASE_WIKI', 'PRODUCT_DOCUMENTATION', 'TECHNICAL_DEVELOPER_DOCUMENTATION', 'API_DOCUMENTATION', 'HELP_CENTER_SUPPORT_DOCS', 'MARKETING_WEBSITE', 'COMPLIANCE_SECURITY_DOCUMENTATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectReadinessItemStateValue" AS ENUM ('SNOOZED', 'NOT_APPLICABLE', 'HELP_REQUESTED');

-- AlterTable
-- Both nullable with no default and no backfill, on purpose: a project with no
-- phase is UNJUDGED. Defaulting existing projects to Discovery would grade every
-- one of them against a phase nobody chose.
ALTER TABLE "project" ADD COLUMN     "projectPhase" "ProjectPhase",
ADD COLUMN     "expectedDevelopmentStartDate" TIMESTAMP(3);

-- AlterTable
-- NULL on every pre-existing link source. An uncategorised link simply does not
-- satisfy the Knowledge Base readiness item; guessing a category would report
-- readiness the project has not earned.
ALTER TABLE "project_context" ADD COLUMN     "knowledgeBaseSourceCategory" "KnowledgeBaseSourceCategory",
ADD COLUMN     "knowledgeBaseSourceCategoryOther" TEXT;

-- CreateTable
CREATE TABLE "project_readiness_item_state" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "state" "ProjectReadinessItemStateValue" NOT NULL,
    "personalForUserId" TEXT,
    "snoozeUntil" TIMESTAMP(3),
    "everHelpRequested" BOOLEAN NOT NULL DEFAULT false,
    "helpRequestedAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_readiness_item_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_readiness_verdict" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "isComplete" BOOLEAN NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_readiness_verdict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_readiness_item_state_projectId_idx" ON "project_readiness_item_state"("projectId");

-- CreateIndex
CREATE INDEX "project_readiness_item_state_userId_idx" ON "project_readiness_item_state"("userId");

-- CreateIndex
CREATE INDEX "project_readiness_item_state_organizationId_idx" ON "project_readiness_item_state"("organizationId");

-- CreateIndex
-- One personal state per item per user. Postgres treats NULLs as distinct, so
-- this index constrains the personal rows only — the project-wide rows are
-- covered by the partial index below.
CREATE UNIQUE INDEX "project_readiness_item_state_projectId_itemKey_personalForU_key" ON "project_readiness_item_state"("projectId", "itemKey", "personalForUserId");

-- CreateIndex
-- A SIXTH index Prisma cannot express, and the one that actually protects the
-- project-wide rows. NOT_APPLICABLE and HELP_REQUESTED leave personalForUserId
-- NULL, and because Postgres treats NULLs as distinct the unique index above
-- would happily admit two "not applicable" rows for the same item. This partial
-- index is what makes the project-wide row genuinely singular.
-- Documented on the model in schema.prisma, since a reader would otherwise see
-- one unique constraint and no hint that a second exists — and a shadow-database
-- diff can read it as drift and try to DROP it.
CREATE UNIQUE INDEX "project_readiness_item_state_project_wide_key" ON "project_readiness_item_state"("projectId", "itemKey") WHERE "personalForUserId" IS NULL;

-- CreateIndex
CREATE INDEX "project_readiness_verdict_projectId_idx" ON "project_readiness_verdict"("projectId");

-- CreateIndex
CREATE INDEX "project_readiness_verdict_userId_idx" ON "project_readiness_verdict"("userId");

-- CreateIndex
CREATE INDEX "project_readiness_verdict_organizationId_idx" ON "project_readiness_verdict"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_readiness_verdict_projectId_itemKey_key" ON "project_readiness_verdict"("projectId", "itemKey");

-- AddForeignKey
ALTER TABLE "project_readiness_item_state" ADD CONSTRAINT "project_readiness_item_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_readiness_item_state" ADD CONSTRAINT "project_readiness_item_state_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_readiness_verdict" ADD CONSTRAINT "project_readiness_verdict_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_readiness_verdict" ADD CONSTRAINT "project_readiness_verdict_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

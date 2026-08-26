-- AlterTable
ALTER TABLE "document_eval" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "evalMode" TEXT NOT NULL DEFAULT 'hybrid',
ADD COLUMN     "evalVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "llmDurationMs" INTEGER,
ADD COLUMN     "llmModel" TEXT,
ADD COLUMN     "llmProvider" TEXT,
ADD COLUMN     "llmScores" JSONB,
ADD COLUMN     "nlpDurationMs" INTEGER,
ADD COLUMN     "nlpScores" JSONB;

-- CreateTable
CREATE TABLE "organization_eval_budget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monthlyBudgetUsd" DOUBLE PRECISION DEFAULT 100.0,
    "currentMonthUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_eval_budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_eval_budget_organizationId_key" ON "organization_eval_budget"("organizationId");

-- CreateIndex
CREATE INDEX "organization_eval_budget_organizationId_idx" ON "organization_eval_budget"("organizationId");

-- AddForeignKey
ALTER TABLE "organization_eval_budget" ADD CONSTRAINT "organization_eval_budget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

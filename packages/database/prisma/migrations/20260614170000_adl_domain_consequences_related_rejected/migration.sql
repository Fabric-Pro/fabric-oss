-- AlterEnum: add the Rejected status
ALTER TYPE "architecture_decision_status" ADD VALUE 'REJECTED';

-- AlterTable: decision gains consequences, domain (category), and related-decision links
ALTER TABLE "architecture_decision" ADD COLUMN "consequences" TEXT;
ALTER TABLE "architecture_decision" ADD COLUMN "domain" TEXT;
ALTER TABLE "architecture_decision" ADD COLUMN "relatedDecisionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable: version snapshot gains consequences
ALTER TABLE "architecture_decision_version" ADD COLUMN "consequences" TEXT;

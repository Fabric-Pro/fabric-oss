-- AlterTable: human endorsement ("vouch") + decision drivers
ALTER TABLE "architecture_decision" ADD COLUMN "decisionDrivers" TEXT;
ALTER TABLE "architecture_decision" ADD COLUMN "vouchedAt" TIMESTAMP(3);
ALTER TABLE "architecture_decision" ADD COLUMN "vouchedById" TEXT;

-- AlterTable: version snapshot also captures decision drivers
ALTER TABLE "architecture_decision_version" ADD COLUMN "decisionDrivers" TEXT;

-- Finding→tickets review flow: propose / preview / accept-decline / apply.
--   (1) New GroupingRunStatus enum + migrate scan_finding_grouping.status onto it
--       (adds AWAITING_REVIEW + APPLYING to the run lifecycle).
--   (2) Drop the agentTicketGenerationEnabled access toggle — the feature is now
--       always available (gated only by a manual click + the review step).
--   (3) Add declinedGroupingThemes JSON store for durable per-theme declines.

-- CreateEnum
CREATE TYPE "GroupingRunStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_REVIEW', 'APPLYING', 'COMPLETED', 'FAILED');

-- AlterTable: migrate scan_finding_grouping.status from ScanStatus to
-- GroupingRunStatus. The existing values (PENDING/RUNNING/COMPLETED/FAILED) all
-- exist in the new enum, so the text round-trip cast is lossless.
ALTER TABLE "scan_finding_grouping" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "scan_finding_grouping" ALTER COLUMN "status" TYPE "GroupingRunStatus" USING ("status"::text::"GroupingRunStatus");
ALTER TABLE "scan_finding_grouping" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable: drop the access toggle, add the durable decline store.
ALTER TABLE "project_scan_config" DROP COLUMN "agentTicketGenerationEnabled";
ALTER TABLE "project_scan_config" ADD COLUMN "declinedGroupingThemes" JSONB;

-- Coding Instructions "publish first, scan afterwards" (Fizzy #2737). A member
-- who can publish may choose to have an upload or in-tab edit published as
-- soon as its integrity checks pass, with the content secret scan running
-- afterwards and its verdict shown on the tab rather than acted on.
--
-- publishBeforeScan is the member's acknowledged opt-in, frozen when the
-- snapshot is created. deferredScanStatus is null for every ordinary snapshot;
-- the publish-first promotion writes PENDING together with READY, and the
-- scan (or the reaper, for a scan whose workflow died) moves it exactly once
-- to PASSED, ISSUES_FOUND or INCOMPLETE. deferredScanFindings carries the same
-- capped { path, reason, detail?, line? } elements as `rejection`: rule ids
-- and line numbers, never matched text.
--
-- Additive only. The three nullable columns have no default, and the boolean's
-- constant default is metadata-only on PostgreSQL 11+, so no ADD COLUMN
-- rewrites the table and every existing row reads as an ordinary snapshot.
-- The previous app version neither reads nor writes any of them. No new
-- table, so no RLS or tenant-extension change: the snapshot table's policies
-- apply to the new columns.

-- CreateEnum
CREATE TYPE "ProjectInstructionDeferredScanStatus" AS ENUM ('PENDING', 'PASSED', 'ISSUES_FOUND', 'INCOMPLETE');

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "deferredScanCompletedAt" TIMESTAMP(3),
ADD COLUMN     "deferredScanFindings" JSONB,
ADD COLUMN     "deferredScanStatus" "ProjectInstructionDeferredScanStatus",
ADD COLUMN     "publishBeforeScan" BOOLEAN NOT NULL DEFAULT false;

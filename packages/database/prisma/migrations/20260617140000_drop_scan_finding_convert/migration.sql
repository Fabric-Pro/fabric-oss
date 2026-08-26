-- Drop the "convert to work item" link columns + index. Convert-to-work-item is
-- removed; findings still reference their source feature via storyId (kept).
DROP INDEX IF EXISTS "scan_finding_convertedStoryId_idx";
ALTER TABLE "scan_finding" DROP COLUMN IF EXISTS "convertedStoryId";
ALTER TABLE "scan_finding" DROP COLUMN IF EXISTS "convertedStoryIdentifier";
ALTER TABLE "scan_finding" DROP COLUMN IF EXISTS "convertedAt";

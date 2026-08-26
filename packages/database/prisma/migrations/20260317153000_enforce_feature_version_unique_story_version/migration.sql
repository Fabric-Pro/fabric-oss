-- Deduplicate existing rows so uniqueness can be enforced safely.
-- Keep the oldest row per (storyId, version) and delete later duplicates.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "storyId", "version"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "feature_version"
)
DELETE FROM "feature_version" fv
USING ranked r
WHERE fv."id" = r."id"
  AND r.rn > 1;

-- Enforce one snapshot row per story/version.
DROP INDEX IF EXISTS "feature_version_storyId_version_idx";

CREATE UNIQUE INDEX "feature_version_storyId_version_key"
ON "feature_version"("storyId", "version");

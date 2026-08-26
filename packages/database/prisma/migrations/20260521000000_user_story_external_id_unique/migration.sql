-- Collapse pre-existing duplicate (projectId, externalId) rows: keep the
-- oldest synced story per pair, unlink the rest (they survive as un-synced
-- local stories). Without this the unique index below would fail to create.
WITH ranked AS (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY "projectId", "externalId"
			ORDER BY "createdAt" ASC, id ASC
		) AS row_num
	FROM "user_story"
	WHERE "externalId" IS NOT NULL
)
UPDATE "user_story"
SET "externalId" = NULL,
    "externalUrl" = NULL,
    "externalMcpServerId" = NULL,
    "pmAutoSyncEnabled" = false
WHERE id IN (SELECT id FROM ranked WHERE row_num > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "user_story_projectId_externalId_key"
	ON "user_story" ("projectId", "externalId")
	WHERE "externalId" IS NOT NULL;

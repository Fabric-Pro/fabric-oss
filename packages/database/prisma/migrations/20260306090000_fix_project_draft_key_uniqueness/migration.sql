WITH ranked_projects AS (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY "draftKey"
			ORDER BY
				CASE
					WHEN status = 'ACTIVE' THEN 0
					WHEN status = 'DRAFT' THEN 1
					ELSE 2
				END,
				"updatedAt" DESC,
				"createdAt" DESC,
				id DESC
		) AS row_num
	FROM "project"
	WHERE "draftKey" IS NOT NULL
)
DELETE FROM "project"
WHERE id IN (
	SELECT id
	FROM ranked_projects
	WHERE row_num > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_draftKey_key" ON "project"("draftKey");

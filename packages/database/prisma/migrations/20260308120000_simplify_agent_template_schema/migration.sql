ALTER TABLE "agent_template"
ADD COLUMN IF NOT EXISTS "instructions" TEXT;

UPDATE "agent_template"
SET "instructions" = COALESCE(
	NULLIF(
		BTRIM(
			CONCAT_WS(
				E'\n\n',
				CASE
					WHEN jsonb_typeof("instructionSections"::jsonb) = 'object'
						AND COALESCE("instructionSections"::jsonb ->> 'role', '') <> ''
					THEN '## Role' || E'\n' || ("instructionSections"::jsonb ->> 'role')
				END,
				CASE
					WHEN jsonb_typeof("instructionSections"::jsonb) = 'object'
						AND COALESCE("instructionSections"::jsonb ->> 'companyContext', '') <> ''
					THEN '## Company Context' || E'\n' || ("instructionSections"::jsonb ->> 'companyContext')
				END,
				CASE
					WHEN jsonb_typeof("instructionSections"::jsonb) = 'object'
						AND COALESCE("instructionSections"::jsonb ->> 'domainKnowledge', '') <> ''
					THEN '## Domain Knowledge' || E'\n' || ("instructionSections"::jsonb ->> 'domainKnowledge')
				END,
				CASE
					WHEN jsonb_typeof("instructionSections"::jsonb) = 'object'
						AND COALESCE("instructionSections"::jsonb ->> 'businessDefinitions', '') <> ''
					THEN '## Business Definitions' || E'\n' || ("instructionSections"::jsonb ->> 'businessDefinitions')
				END,
				CASE
					WHEN jsonb_typeof("instructionSections"::jsonb) = 'object'
						AND COALESCE("instructionSections"::jsonb ->> 'queryFormatting', '') <> ''
					THEN '## Query Formatting' || E'\n' || ("instructionSections"::jsonb ->> 'queryFormatting')
				END,
				CASE
					WHEN jsonb_typeof("instructionSections"::jsonb) = 'object'
						AND COALESCE("instructionSections"::jsonb ->> 'outputFormat', '') <> ''
					THEN '## Output Format' || E'\n' || ("instructionSections"::jsonb ->> 'outputFormat')
				END
			)
		),
		''
	),
	"description"
)
WHERE COALESCE(BTRIM("instructions"), '') = '';

UPDATE "agent_template"
SET "instructions" = "description"
WHERE "instructions" IS NULL;

ALTER TABLE "agent_template"
ALTER COLUMN "instructions" SET NOT NULL;

ALTER TABLE "agent_template"
DROP COLUMN IF EXISTS "instructionSections",
DROP COLUMN IF EXISTS "useCases",
DROP COLUMN IF EXISTS "proTips",
DROP COLUMN IF EXISTS "knowledgeSources",
DROP COLUMN IF EXISTS "requiredMcpServers",
DROP COLUMN IF EXISTS "tools",
DROP COLUMN IF EXISTS "triggerTypes";

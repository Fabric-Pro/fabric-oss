-- Spec: 2026-05-21-roadmap-unique-sequential-ticket-ids
--
-- This migration introduces a per-project monotonic story-identifier counter
-- (Project.nextStoryNumber) and a per-project unique constraint on
-- (UserStory.projectId, UserStory.identifier). The four statements below MUST
-- run in this exact order so the unique constraint can be created on any DB
-- that may contain pre-existing duplicates (e.g. the reported B-011 case):
--
--   1. Add the counter column to "project".
--   2. Deterministically suffix pre-existing duplicate (projectId, identifier)
--      rows so the unique constraint can apply. This is the single narrow
--      exception to the spec's forward-only policy — without it step 4 fails
--      on any DB containing duplicate identifiers.
--   3. Backfill "project"."next_story_number" to 1 + MAX(numeric suffix of
--      existing identifiers in that project), so newly allocated numbers
--      cannot collide with any legacy F-/B-/US- identifier.
--   4. Create the unique index (Prisma-emitted, per `@@unique` in schema).

-- 1. Add the per-project counter column.
ALTER TABLE "project" ADD COLUMN "next_story_number" INTEGER NOT NULL DEFAULT 1;

-- 2. Resolve pre-existing duplicate identifiers (narrow exception to A1).
--    Keep the oldest row's identifier untouched (rn = 1); suffix the rest in
--    (createdAt ASC, id ASC) order with -dup2, -dup3, ... Determinism: the
--    tie-breaker on "id" ensures repeated runs on the same data produce
--    identical suffixes.
WITH ranked AS (
  SELECT
    "id",
    "projectId",
    "identifier",
    ROW_NUMBER() OVER (
      PARTITION BY "projectId", "identifier"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "user_story"
)
UPDATE "user_story" us
SET "identifier" = ranked."identifier" || '-dup' || ranked.rn
FROM ranked
WHERE us."id" = ranked."id"
  AND ranked.rn > 1;

-- 3. Backfill Project.nextStoryNumber. regexp_match extracts the first run of
--    digits from an identifier: "F-001" -> 1, "B-011" -> 11, "US-007" -> 7,
--    "42" -> 42, "7-dup2" -> 7. Identifiers without any digit are ignored
--    (treated as if absent for that project). Projects with zero matchable
--    identifiers fall through to the default of 1 via COALESCE.
UPDATE "project" p
SET "next_story_number" = COALESCE((
  SELECT MAX( (regexp_match("identifier", '(\d+)'))[1]::int ) + 1
  FROM "user_story"
  WHERE "projectId" = p."id"
), 1);

-- 4. CreateIndex (Prisma-emitted for `@@unique([projectId, identifier])`).
CREATE UNIQUE INDEX "user_story_projectId_identifier_key" ON "user_story"("projectId", "identifier");

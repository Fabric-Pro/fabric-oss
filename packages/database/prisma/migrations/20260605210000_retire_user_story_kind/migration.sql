-- Retire the legacy USER_STORY work-item type. Fabric supports exactly two
-- work-item types now: FEATURE and BUG. "User Story" is no longer a Fabric
-- type (it remains the native leaf type of external PM tools like ADO, which
-- is handled by the push/pull mapping layer, not this enum).
--
-- Step 1 — migrate existing data to FEATURE BEFORE the type swap, so no
-- USER_STORY values remain when the column is recast to the narrowed enum.
UPDATE "user_story" SET "kind" = 'FEATURE' WHERE "kind" = 'USER_STORY';

-- prompt_binding.storyKind: promote USER_STORY stage bindings to FEATURE.
-- The @@unique(targetType, targetKey, documentType, storyKind, scope, userId,
-- organizationId) constraint means a USER_STORY row can collide with an
-- existing FEATURE row for the same target/scope — a blind UPDATE would throw
-- a duplicate-key error. So first DROP the USER_STORY rows that would collide
-- (the FEATURE binding already covers that target), then promote the rest.
-- `IS NOT DISTINCT FROM` matches NULL userId/organizationId (personal/system
-- scope) the same way the unique index does.
DELETE FROM "prompt_binding" pb
WHERE pb."storyKind" = 'USER_STORY'
  AND EXISTS (
    SELECT 1
    FROM "prompt_binding" other
    WHERE other."storyKind" = 'FEATURE'
      AND other."targetType" = pb."targetType"
      AND other."targetKey" = pb."targetKey"
      AND other."documentType" = pb."documentType"
      AND other."scope" = pb."scope"
      AND other."userId" IS NOT DISTINCT FROM pb."userId"
      AND other."organizationId" IS NOT DISTINCT FROM pb."organizationId"
  );
UPDATE "prompt_binding" SET "storyKind" = 'FEATURE' WHERE "storyKind" = 'USER_STORY';

-- Step 2 — recreate the StoryKind enum without USER_STORY. Postgres cannot
-- DROP a value from an enum in place, so rename-create-swap-drop.
ALTER TYPE "StoryKind" RENAME TO "StoryKind_old";
CREATE TYPE "StoryKind" AS ENUM ('FEATURE', 'BUG');

-- user_story.kind: drop default, swap type via text cast, restore default.
ALTER TABLE "user_story" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "user_story"
  ALTER COLUMN "kind" TYPE "StoryKind" USING ("kind"::text::"StoryKind");
ALTER TABLE "user_story" ALTER COLUMN "kind" SET DEFAULT 'FEATURE';

-- prompt_binding.storyKind: nullable, no default.
ALTER TABLE "prompt_binding"
  ALTER COLUMN "storyKind" TYPE "StoryKind" USING ("storyKind"::text::"StoryKind");

DROP TYPE "StoryKind_old";

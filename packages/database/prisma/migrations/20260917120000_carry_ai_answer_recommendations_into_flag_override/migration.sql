-- Carry every organization enabled on the SQL-only "aiAnswerRecommendationsEnabled"
-- column into the runtime flag registry (Fizzy #2300), as a per-organization
-- override row for AI_ANSWER_RECOMMENDATIONS. From this release the reader
-- resolves that flag and no code reads the column.
--
-- Only true is copied. False is the column default, and an organization-level
-- false row would wrongly exclude that organization from a later instance-wide ON.
--
-- An existing row for this key wins on conflict: it was written deliberately,
-- either by hand or from the admin console of a build that already includes
-- this flag, before this migration ran.
--
-- The column itself is kept (expand/contract): the previous build still selects it
-- while a deploy is in progress.
--
-- migration-lint: allow unbatched-backfill — this set-valued INSERT holds locks that are bounded by the number of enabled organizations. Its SELECT reads "organization" without FOR UPDATE, taking ACCESS SHARE on that table. The foreign key from the override table to "organization"("id") makes each inserted row take FOR KEY SHARE on its organization row until commit, which delays only a concurrent delete of, or key change to, an enabled organization. The INSERT takes ROW EXCLUSIVE on the override table, which concurrent writers share, and row-locks only the rows it creates, because ON CONFLICT DO NOTHING takes no lock on a row that already exists. It writes at most one five-column row per enabled organization. And this file is exactly this one statement, pinned by its shape test, because the marker suppresses the rule for the whole file.
INSERT INTO "organization_feature_flag_override"
  ("key", "organizationId", "enabled", "updatedAt", "updatedBy")
SELECT 'AI_ANSWER_RECOMMENDATIONS', "id", true, CURRENT_TIMESTAMP,
       'migration:ai-answer-recommendations'
FROM "organization"
WHERE "aiAnswerRecommendationsEnabled" = true
ON CONFLICT ("key", "organizationId") DO NOTHING;

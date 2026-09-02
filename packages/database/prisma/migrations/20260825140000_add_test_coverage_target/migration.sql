-- AddTestCoverageTarget
-- Splits the single `coverageTarget` number into its two consumers: the
-- reporting rings keep reading `coverageTarget` (automation over test cases),
-- and the Done transition gate gets this dedicated column — % of acceptance
-- criteria that need a linked case, 0 = off.
--
-- Defaulting every existing row to 0 (gate off) is deliberate: nobody could
-- knowingly configure an acceptance-criteria gate before this column existed,
-- because the screen described that number as an automation-reporting target
-- and the gate borrowed it silently. Carrying the old value here would arm a
-- blocking gate on projects that never chose one.
--
-- The devices default moves with it: one combination, matching what a run
-- actually reads (`resolutions[0]`), so the stored default stops shipping a
-- second resolution nothing ever used.

ALTER TABLE "project_qa_settings" ADD COLUMN "testCoverageTarget" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "project_qa_settings" ALTER COLUMN "resolutions" SET DEFAULT ARRAY['1920x1080']::TEXT[];

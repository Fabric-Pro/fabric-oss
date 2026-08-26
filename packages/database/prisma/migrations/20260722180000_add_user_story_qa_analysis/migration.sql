-- QA tab: persisted AI analysis for the maturation editor's QA tab
-- (per-criterion under-specification warnings, integration-test implications,
-- E2E scenario outlines, plus the spec hash + depth it was generated at).
-- Test cases themselves are NOT stored here — they are TestCase rows linked
-- via TestCaseWorkItemLink. Additive + nullable → existing rows untouched.
ALTER TABLE "user_story" ADD COLUMN "qaAnalysis" JSONB;

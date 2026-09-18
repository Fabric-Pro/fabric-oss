-- Questions a planning analysis folded into a decision root because they named
-- the same subject, stored as a list when they are folded, so a settled
-- approval can be scoped to what the member was asked (Fizzy #1988).
-- `foldedQuestionsVersion` is the `analysisVersion` of the write that set the
-- list; a reader trusts the list only while the two match. A constant default
-- and a nullable column add without rewriting the table.
ALTER TABLE "publishing_topic_decision_entry"
  ADD COLUMN "foldedQuestions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "foldedQuestionsVersion" INTEGER;

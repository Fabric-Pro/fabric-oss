-- When the ARCHITECTURE review lens last ran over a read pull request
-- (card 1642 phase 3).
--
-- No model column beside it, unlike qaAnalysisModel: that lens COMPUTES its
-- findings from Atlas's import graph, so there is no model to attribute. A
-- nullable column pretending otherwise would invite one.
ALTER TABLE "pull_request_review"
    ADD COLUMN "architectureAnalysedAt" TIMESTAMP(3);

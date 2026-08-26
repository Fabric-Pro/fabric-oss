-- Observations a review lens made about a pull request (card 1642 phase 2).
--
-- Deliberately NOT stored on test_finding: that table is a FAILING TEST — keyed
-- on a fingerprint derived from a test's identity, requiring a test name, and
-- its RESOLVED state means "the test went green". A review observation like
-- "AC 3 has no case covering it" has none of those, by definition.

ALTER TABLE "pull_request_review"
    ADD COLUMN "qaAnalysedAt" TIMESTAMP(3),
    ADD COLUMN "qaAnalysisModel" TEXT;

CREATE TABLE "pull_request_review_finding" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "lens" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "filePath" TEXT,
    "storyId" TEXT,
    "criterionRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "promotedStoryId" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_review_finding_pkey" PRIMARY KEY ("id")
);

-- Re-running a lens replaces its findings for that review, so the read path is
-- always (reviewId, lens) and there is no natural key to dedupe on.
CREATE INDEX "pull_request_review_finding_reviewId_lens_idx"
    ON "pull_request_review_finding"("reviewId", "lens");
CREATE INDEX "pull_request_review_finding_projectId_status_createdAt_idx"
    ON "pull_request_review_finding"("projectId", "status", "createdAt");
CREATE INDEX "pull_request_review_finding_userId_idx"
    ON "pull_request_review_finding"("userId");
CREATE INDEX "pull_request_review_finding_organizationId_idx"
    ON "pull_request_review_finding"("organizationId");
CREATE INDEX "pull_request_review_finding_storyId_idx"
    ON "pull_request_review_finding"("storyId");
CREATE INDEX "pull_request_review_finding_promotedStoryId_idx"
    ON "pull_request_review_finding"("promotedStoryId");

ALTER TABLE "pull_request_review_finding"
    ADD CONSTRAINT "pull_request_review_finding_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "pull_request_review"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_review_finding"
    ADD CONSTRAINT "pull_request_review_finding_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_review_finding"
    ADD CONSTRAINT "pull_request_review_finding_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_review_finding"
    ADD CONSTRAINT "pull_request_review_finding_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A deleted feature must not take its review findings with it: the observation
-- ("this change has no coverage") outlives the work item it pointed at.
ALTER TABLE "pull_request_review_finding"
    ADD CONSTRAINT "pull_request_review_finding_storyId_fkey"
    FOREIGN KEY ("storyId") REFERENCES "user_story"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pull_request_review_finding"
    ADD CONSTRAINT "pull_request_review_finding_promotedStoryId_fkey"
    FOREIGN KEY ("promotedStoryId") REFERENCES "user_story"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- One review of one pull request in a customer's connected repository.
--
-- Phase 1 of card 1642: stores what Fabric READ (the PR's identity and the diff
-- it fetched), not what it concluded. Findings land on the existing TestFinding
-- shape in a later phase, so there is never a second findings model.

CREATE TABLE "pull_request_review" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "authorLabel" TEXT,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "prUrl" TEXT,
    "diff" TEXT,
    "diffTruncated" BOOLEAN NOT NULL DEFAULT false,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'READ',
    "failureText" TEXT,
    "requestedById" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_review_pkey" PRIMARY KEY ("id")
);

-- Re-reviewing the same head commit replaces the previous read rather than
-- accumulating duplicates. A NEW commit is a genuinely new review, which is why
-- headSha is part of the key.
CREATE UNIQUE INDEX "pull_request_review_identity_key"
    ON "pull_request_review"("projectId", "provider", "repoOwner", "repoName", "prNumber", "headSha");

CREATE INDEX "pull_request_review_projectId_createdAt_idx"
    ON "pull_request_review"("projectId", "createdAt" DESC);
CREATE INDEX "pull_request_review_userId_idx" ON "pull_request_review"("userId");
CREATE INDEX "pull_request_review_organizationId_idx"
    ON "pull_request_review"("organizationId");

ALTER TABLE "pull_request_review"
    ADD CONSTRAINT "pull_request_review_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_review"
    ADD CONSTRAINT "pull_request_review_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_review"
    ADD CONSTRAINT "pull_request_review_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_review"
    ADD CONSTRAINT "pull_request_review_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

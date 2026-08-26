-- Card 1688 RCA / mocks C5-C6 — one distinct FAILURE, tracked across runs.
--
-- Until now a recurring failure had no identity: RCA deduplicated on
-- (originTestCaseId + a non-terminal bug), which works only because one case
-- maps to one bug. It cannot group two DIFFERENT failures of the same case, and
-- it cannot recognise the same failure arriving from another case or provider.
-- `fingerprintFinding` was written for exactly this and had nowhere to write to.
--
-- A finding is the OBSERVATION; a bug is the decision to act on it. Most
-- findings never become bugs (flakes, known breakage, third-party) — which is
-- the reason they need somewhere to live that is not the backlog.
--
-- Top-level tenant table: XOR organizationId / userId copied from the parent
-- project, registered `user_owned` for RLS in scripts/apply-rls-direct.ts and in
-- src/tenant-db.ts. Both registrations are required — rls-coverage.test.ts fails
-- when either is missing, and a model absent from tenant-db.ts gets a null
-- tenant filter, which runs UNFILTERED rather than failing closed.

CREATE TYPE "test_finding_status" AS ENUM ('OPEN', 'RESOLVED', 'PROMOTED', 'IGNORED');

CREATE TABLE "test_finding" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "classname" TEXT,
    "failureMessage" TEXT,
    "status" "test_finding_status" NOT NULL DEFAULT 'OPEN',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "testCaseId" TEXT,
    "lastPipelineRunId" TEXT,
    "promotedStoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "test_finding_pkey" PRIMARY KEY ("id")
);

-- The grouping key. Unique PER PROJECT: the same fault seen in two projects is
-- two findings, because it is two teams' problem. This is also what makes
-- ingestion idempotent — a re-ingested run bumps `occurrences` via upsert
-- instead of inserting a duplicate.
CREATE UNIQUE INDEX "test_finding_projectId_fingerprint_key"
    ON "test_finding"("projectId", "fingerprint");

-- Serves the findings list: this project's open failures, most recent first.
CREATE INDEX "test_finding_projectId_status_lastSeenAt_idx"
    ON "test_finding"("projectId", "status", "lastSeenAt" DESC);

CREATE INDEX "test_finding_testCaseId_idx" ON "test_finding"("testCaseId");

ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: deleting a case or pruning an old run must not delete
-- the record that the failure happened.
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_testCaseId_fkey"
    FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_lastPipelineRunId_fkey"
    FOREIGN KEY ("lastPipelineRunId") REFERENCES "test_pipeline_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_promotedStoryId_fkey"
    FOREIGN KEY ("promotedStoryId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

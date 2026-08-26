-- Run evidence gets a retention window, and a ledger that makes one possible.
--
-- Nothing has ever deleted a QA run's screenshots. Storage grew without bound,
-- and deleting a run, a case or a whole project left its objects behind for
-- good.
--
-- The obvious fix — walk the step log and delete what it points at — cannot
-- work, for two reasons that only surface when you look at the data:
--
--   1. An evidence key names no run. It is
--      {tenant}/qa-runs/{projectId}/{testCaseId}/step-{n}-{ms}.png, so every run
--      of the same case writes under one prefix and the only thing separating
--      them is a millisecond suffix. Listing by prefix answers "this case, every
--      run it ever had", which is not the question a sweep asks.
--   2. The only pointer dies with its owner. test_agentic_step_log.evidenceKey
--      hangs off test_result_event, which cascades from test_case, which
--      cascades from project. Permanently deleting a project makes Postgres
--      remove every row naming those objects, with no application code running —
--      so the pointer disappears and the data does not.
--
-- Hence a ledger with NO foreign keys. That is the whole design, not an
-- oversight: a relation to project, test_case or test_agentic_run would cascade
-- the row away and recreate the orphan this exists to prevent. organizationId
-- and userId are plain columns for the same reason — they carry the RLS
-- predicate, and an FK to organization would delete the ledger the moment an
-- organization was removed. Row-level security compares values and has no
-- interest in whether the referenced row still exists.
--
-- storageKey is UNIQUE so a retried Temporal activity cannot register the same
-- screenshot twice.
CREATE TABLE "test_run_evidence" (
  "id"             TEXT NOT NULL,
  "bucket"         TEXT NOT NULL,
  "storageKey"     TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "runId"          TEXT NOT NULL,
  "testCaseId"     TEXT NOT NULL,
  "stepOrder"      INTEGER NOT NULL,
  "organizationId" TEXT,
  "userId"         TEXT,
  "capturedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "test_run_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "test_run_evidence_storageKey_key"
  ON "test_run_evidence"("storageKey");

-- The sweep pages a project's expired rows on the first index; the second
-- supports the global ordering when no project filter applies.
CREATE INDEX "test_run_evidence_projectId_capturedAt_idx"
  ON "test_run_evidence"("projectId", "capturedAt");
CREATE INDEX "test_run_evidence_capturedAt_idx"
  ON "test_run_evidence"("capturedAt");

-- Retention is a window rather than a delete cascade (product ruling,
-- 2026-07-31). Evidence outlives its run, its case and its project: deleting a
-- test case should not erase the proof of what it once did, and an auditor
-- asking what a run actually showed must not be answered by whether somebody has
-- since tidied up the case.
--
-- 90 days rather than 0, because a default of "keep forever" would preserve
-- exactly the unbounded growth this exists to stop, and would do it silently. 0
-- remains available and now MEANS keep indefinitely — an explicit choice a team
-- under a retention obligation can make, rather than an accident.
ALTER TABLE "project_qa_settings"
  ADD COLUMN "evidenceRetentionDays" INTEGER NOT NULL DEFAULT 90;

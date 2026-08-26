-- A test run Fabric ORCHESTRATES itself — driving a browser through a
-- Fabric-authored case against a live environment — as opposed to one it ingests
-- from the customer's CI.
--
-- Deliberately small for what it enables. The per-case verdicts are NOT here:
-- a finished agentic run writes an ordinary `test_pipeline_run` (provider
-- `fabric-agentic`) plus the usual `test_result_event` rows, so linkage,
-- findings, RCA, per-feature scoping and the coverage rollup all work on it with
-- no changes. This table is only the envelope — where the run pointed, what it
-- was allowed to cost, why it was refused, and which workflow drives it.
--
-- Two snapshot columns are load-bearing rather than redundant:
--   * `targetBaseUrl` / `environmentType` copy the environment AT DISPATCH.
--     An environment can be edited or deleted; "which URL did this run hit, and
--     was that production" must still be answerable a year later.
--   * `test_agentic_step_log.action` / `.expected` copy the test-case step as it
--     read at run time, so editing a case cannot retroactively change what the
--     runner was asked to do.
--
-- Additive throughout; no existing row or behaviour changes.

CREATE TYPE "agentic_run_status" AS ENUM ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'CANCELLED', 'REFUSED');
CREATE TYPE "agentic_step_status" AS ENUM ('PASSED', 'FAILED', 'BLOCKED', 'SKIPPED');

CREATE TABLE "test_agentic_run" (
    "id"                TEXT NOT NULL,
    "projectId"         TEXT NOT NULL,
    "organizationId"    TEXT,
    "userId"            TEXT,
    "status"            "agentic_run_status" NOT NULL DEFAULT 'QUEUED',
    "workflowId"        TEXT,
    "environmentId"     TEXT,
    "targetBaseUrl"     TEXT NOT NULL,
    "environmentType"   "ProjectEnvironmentType" NOT NULL,
    "estimatedCostUsd"  DECIMAL(10,4) NOT NULL,
    "costCapUsd"        DECIMAL(10,4) NOT NULL,
    "actualCostUsd"     DECIMAL(10,4),
    "browser"           TEXT NOT NULL,
    "resolution"        TEXT NOT NULL,
    "caseCount"         INTEGER NOT NULL DEFAULT 0,
    "passedCount"       INTEGER NOT NULL DEFAULT 0,
    "failedCount"       INTEGER NOT NULL DEFAULT 0,
    "blockedCount"      INTEGER NOT NULL DEFAULT 0,
    "refusalReason"     TEXT,
    "pipelineRunId"     TEXT,
    "triggeredByUserId" TEXT,
    "startedAt"         TIMESTAMP(3),
    "finishedAt"        TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_agentic_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "test_agentic_run_projectId_createdAt_idx" ON "test_agentic_run"("projectId", "createdAt" DESC);
CREATE INDEX "test_agentic_run_projectId_status_idx" ON "test_agentic_run"("projectId", "status");

ALTER TABLE "test_agentic_run"
    ADD CONSTRAINT "test_agentic_run_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "test_agentic_run_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "test_agentic_run_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "test_agentic_run_pipelineRunId_fkey"
        FOREIGN KEY ("pipelineRunId") REFERENCES "test_pipeline_run"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "test_agentic_run_triggeredByUserId_fkey"
        FOREIGN KEY ("triggeredByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-step log. Hangs off test_result_event — the per-case verdict already has a
-- home every QA surface renders, and a second one would mean two answers to
-- "how did this case do". No tenant columns: access inherits through
-- test_result_event -> test_case, the same columnless-child shape
-- test_case_activity uses.
CREATE TABLE "test_agentic_step_log" (
    "id"                TEXT NOT NULL,
    "testResultEventId" TEXT NOT NULL,
    "order"             DOUBLE PRECISION NOT NULL DEFAULT 0,
    "action"            TEXT NOT NULL,
    "expected"          TEXT NOT NULL,
    "status"            "agentic_step_status" NOT NULL,
    "observation"       TEXT,
    "evidenceKey"       TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_agentic_step_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "test_agentic_step_log_testResultEventId_order_idx" ON "test_agentic_step_log"("testResultEventId", "order");

ALTER TABLE "test_agentic_step_log"
    ADD CONSTRAINT "test_agentic_step_log_testResultEventId_fkey"
        FOREIGN KEY ("testResultEventId") REFERENCES "test_result_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

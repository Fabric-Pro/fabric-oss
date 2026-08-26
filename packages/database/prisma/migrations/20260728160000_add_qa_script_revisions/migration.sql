CREATE TYPE "test_case_script_revision_origin" AS ENUM (
    'MANUAL',
    'AGENT_RUN_AND_REPO',
    'REPO_ONLY',
    'REVERT'
);

CREATE TABLE "test_case_script_revision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "origin" "test_case_script_revision_origin" NOT NULL,
    "authoredByUserId" TEXT,
    "authorNameSnapshot" TEXT,
    "authorEmailSnapshot" TEXT,
    "sourceResultEventId" TEXT,
    "restoredFromRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_case_script_revision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "test_case_script_revision_testCaseId_createdAt_idx"
    ON "test_case_script_revision"("testCaseId", "createdAt" DESC);

CREATE INDEX "test_case_script_revision_projectId_idx"
    ON "test_case_script_revision"("projectId");

ALTER TABLE "test_case_script_revision"
    ADD CONSTRAINT "test_case_script_revision_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_case_script_revision"
    ADD CONSTRAINT "test_case_script_revision_testCaseId_fkey"
    FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_result_event"
    ADD COLUMN "scriptRevisionId" TEXT;

ALTER TABLE "test_agentic_case_result"
    ADD COLUMN "scriptRevisionId" TEXT;

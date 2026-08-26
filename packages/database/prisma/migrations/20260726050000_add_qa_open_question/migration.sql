-- QA hardening phase 5 — the Open Questions Log.
--
-- Testing unknowns raised during QA planning previously lived as prose inside a
-- QA analysis, so nothing could list what was still open, who raised it, or
-- whether it was ever answered. This makes them a queryable record.
--
-- Top-level tenant table: XOR org/user columns copied from the parent Project,
-- registered `user_owned` for RLS and in tenant-db.ts (the parity guard added in
-- #2291 fails CI if either is missed).

CREATE TYPE "QaOpenQuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'DEFERRED');

CREATE TABLE "qa_open_question" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userStoryId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "QaOpenQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "askedByLabel" TEXT NOT NULL,
    "askedById" TEXT,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qa_open_question_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "qa_open_question_projectId_status_createdAt_idx" ON "qa_open_question"("projectId", "status", "createdAt");
CREATE INDEX "qa_open_question_userStoryId_idx" ON "qa_open_question"("userStoryId");
CREATE INDEX "qa_open_question_userId_idx" ON "qa_open_question"("userId");
CREATE INDEX "qa_open_question_organizationId_idx" ON "qa_open_question"("organizationId");

ALTER TABLE "qa_open_question" ADD CONSTRAINT "qa_open_question_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: a deleted feature must not silently erase the open
-- questions raised against it — they become project-wide, which is the honest
-- outcome.
ALTER TABLE "qa_open_question" ADD CONSTRAINT "qa_open_question_userStoryId_fkey" FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "qa_open_question" ADD CONSTRAINT "qa_open_question_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "qa_open_question" ADD CONSTRAINT "qa_open_question_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Publishing Suite Phase 2A-3 (Fizzy #1851): the decision thread for one
-- publishing topic — question roots, their answer replies, and AI Update notes.
--
-- Hand-authored, like the sibling 20260830120000 migration, because the partial
-- unique index and the two CHECK constraints at the bottom cannot be expressed
-- in the Prisma schema. They are documented on the model too.
--
-- The table is new and carries no rows, so every constraint validates
-- immediately and NOT VALID is unnecessary. There is deliberately no
-- `SET LOCAL row_security = off` in this file: an unguarded one blocked every
-- staging deploy once already, and this migration does not need it.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registration for this table is in `scripts/apply-rls-direct.ts`.

-- CreateEnum
CREATE TYPE "PublishingDecisionEntryKind" AS ENUM ('QUESTION', 'AI_UPDATE');

-- CreateTable
CREATE TABLE "publishing_topic_decision_entry" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "parentId" TEXT,
    "authorType" "decision_author_type" NOT NULL,
    "authorUserId" TEXT,
    "status" "decision_status" NOT NULL DEFAULT 'OPEN',
    "kind" "PublishingDecisionEntryKind" NOT NULL DEFAULT 'QUESTION',
    "questionId" TEXT,
    "decisionKind" TEXT,
    "subject" TEXT,
    "summary" TEXT,
    "content" TEXT,
    "recommendedResponse" TEXT,
    "whyItMatters" TEXT,
    "answerSource" "answer_source",
    "analysisVersion" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_topic_decision_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "publishing_topic_decision_entry_topicId_createdAt_idx" ON "publishing_topic_decision_entry"("topicId", "createdAt");
CREATE INDEX "publishing_topic_decision_entry_parentId_idx" ON "publishing_topic_decision_entry"("parentId");
CREATE INDEX "publishing_topic_decision_entry_organizationId_idx" ON "publishing_topic_decision_entry"("organizationId");
CREATE INDEX "publishing_topic_decision_entry_userId_idx" ON "publishing_topic_decision_entry"("userId");

-- AddForeignKey
ALTER TABLE "publishing_topic_decision_entry" ADD CONSTRAINT "publishing_topic_decision_entry_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_decision_entry" ADD CONSTRAINT "publishing_topic_decision_entry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_decision_entry" ADD CONSTRAINT "publishing_topic_decision_entry_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "publishing_topic_decision_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_decision_entry" ADD CONSTRAINT "publishing_topic_decision_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_decision_entry" ADD CONSTRAINT "publishing_topic_decision_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_decision_entry" ADD CONSTRAINT "publishing_topic_decision_entry_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The three things Prisma cannot express.
-- ---------------------------------------------------------------------------

-- THE RECONCILIATION KEY. At most one live question root per (topic, questionId).
-- This index is the enforcement; the read in `reconcileTopicQuestions` only
-- turns the race into an in-place update instead of a constraint error. Without
-- it every regeneration mints a duplicate of a question the user may already
-- have answered — the exact defect `DecisionLogEntry`'s AC-2.4 dedupe exists to
-- prevent. Scoped to roots (`parentId IS NULL`) because replies carry no
-- questionId, and to live rows so a soft-deleted root does not block a re-ask.
CREATE UNIQUE INDEX "publishing_topic_decision_entry_question_root"
    ON "publishing_topic_decision_entry" ("topicId", "questionId")
    WHERE "parentId" IS NULL AND "deletedAt" IS NULL;

-- Strict tenant XOR, matching `publishing_topic_tenant_xor`. `<>` means EXACTLY
-- one of the two is non-null, so a row with neither is rejected as well. RLS is
-- not a substitute: its organization branch permits any `userId`, it does not
-- require null.
ALTER TABLE "publishing_topic_decision_entry"
    ADD CONSTRAINT "publishing_topic_decision_entry_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- A QUESTION root must be identifiable. Without a questionId the partial unique
-- index above cannot see it, so it would silently escape reconciliation and
-- duplicate on the next regeneration — a row that looks fine and breaks the one
-- invariant this table has. Replies and AI Updates carry no questionId.
ALTER TABLE "publishing_topic_decision_entry"
    ADD CONSTRAINT "publishing_topic_decision_entry_question_identified"
    CHECK ("kind" <> 'QUESTION' OR "parentId" IS NOT NULL OR "questionId" IS NOT NULL);

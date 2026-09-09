-- Per-question assignment for the Publishing Suite (Fizzy #1851): who a topic's
-- open question is waiting on.
--
-- Mirrors `decision_log_entry_assignee` (Fizzy #1751), which routes maturation
-- questions the same way — the owner asked for the FMv2 behaviour, so this is
-- the FMv2 table adapted to a publishing question rather than a second design.
--
-- Hand-authored because the tenant XOR at the bottom cannot be expressed in the
-- Prisma schema. It is documented on the model too.
--
-- The table is new and carries no rows, so the constraint validates immediately
-- and NOT VALID is unnecessary. There is deliberately no `SET LOCAL
-- row_security = off` here: an unguarded one blocked every staging deploy once
-- already, and this migration does not need it.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registration for this table is in `scripts/apply-rls-direct.ts`.

-- CreateTable
CREATE TABLE "publishing_topic_question_assignee" (
    "id" TEXT NOT NULL,
    "decisionEntryId" TEXT NOT NULL,
    "assigneeUserId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_topic_question_assignee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per (question, person). Set semantics on the write side depend on
-- this: `setTopicQuestionAssignees` leaves existing rows untouched so a re-save
-- cannot silently transfer who created the assignment, and without the
-- constraint a concurrent double-save would duplicate instead of colliding.
-- The name is Prisma's own for this `@@unique`, truncated to Postgres's 63-char
-- identifier limit. A hand-picked name would read better and would show up as
-- permanent drift on every `migrate diff`, which is how a real schema change
-- ends up buried in noise nobody reads any more.
CREATE UNIQUE INDEX "publishing_topic_question_assignee_decisionEntryId_assignee_key" ON "publishing_topic_question_assignee"("decisionEntryId", "assigneeUserId");
CREATE INDEX "publishing_topic_question_assignee_decisionEntryId_idx" ON "publishing_topic_question_assignee"("decisionEntryId");
CREATE INDEX "publishing_topic_question_assignee_assigneeUserId_idx" ON "publishing_topic_question_assignee"("assigneeUserId");
CREATE INDEX "publishing_topic_question_assignee_projectId_idx" ON "publishing_topic_question_assignee"("projectId");
CREATE INDEX "publishing_topic_question_assignee_organizationId_idx" ON "publishing_topic_question_assignee"("organizationId");
CREATE INDEX "publishing_topic_question_assignee_userId_idx" ON "publishing_topic_question_assignee"("userId");

-- AddForeignKey
ALTER TABLE "publishing_topic_question_assignee" ADD CONSTRAINT "publishing_topic_question_assignee_decisionEntryId_fkey" FOREIGN KEY ("decisionEntryId") REFERENCES "publishing_topic_decision_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_question_assignee" ADD CONSTRAINT "publishing_topic_question_assignee_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_question_assignee" ADD CONSTRAINT "publishing_topic_question_assignee_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_question_assignee" ADD CONSTRAINT "publishing_topic_question_assignee_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_question_assignee" ADD CONSTRAINT "publishing_topic_question_assignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_question_assignee" ADD CONSTRAINT "publishing_topic_question_assignee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The thing Prisma cannot express.
-- ---------------------------------------------------------------------------

-- Strict tenant XOR, matching `publishing_topic_decision_entry_tenant_xor` on
-- the parent. `<>` means EXACTLY one of the two is non-null, so a row with
-- neither is rejected as well. The child copies both columns from the question,
-- so a row that fails this could only be one whose tenant disagrees with its
-- parent's — which is precisely what must never exist. RLS is not a substitute:
-- its organization branch permits any `userId`, it does not require null.
ALTER TABLE "publishing_topic_question_assignee"
    ADD CONSTRAINT "publishing_topic_question_assignee_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- Publishing Suite Phase 2B-1 (Fizzy #1853): generated content drafts for a
-- publishing topic, and the working draft a user owns.
--
-- Hand-authored rather than generated, because five of the things these tables
-- need cannot be expressed in the Prisma schema — the composite foreign key
-- with its subset delete action, the unique constraint that key references, the
-- partial unique index, and the three CHECK constraints. All are documented on
-- the models too.
--
-- Both tables are new and carry no rows, so every constraint validates
-- immediately and NOT VALID is unnecessary. There is deliberately no
-- `SET LOCAL row_security = off` anywhere in this file: an unguarded one blocked
-- every staging deploy once already, and this migration does not need it.
--
-- RLS is NOT applied here. In this repository row-level security lives in
-- `scripts/apply-rls-direct.ts` and is applied out of band by
-- `pnpm --filter @repo/database apply:rls`; the sibling
-- `20260830120000_add_publishing_topic_planning_analysis` migration contains no
-- policy either. The registration for both tables is in that script.
--
-- `"PublishingTopicPostType"` ALREADY EXISTS (created by
-- 20260716120000_add_publishing_suite_1b_fields) and must NOT be recreated —
-- the same warning 20260824190000_add_publishing_preference_fields carries. It
-- has no `@@map`, so its Postgres name is the Prisma name verbatim; so does
-- "PublishingDraftStatus" below.

-- CreateEnum
CREATE TYPE "PublishingDraftStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "publishing_topic_draft" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "postType" "PublishingTopicPostType" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PublishingDraftStatus" NOT NULL DEFAULT 'GENERATING',
    "content" JSONB,
    "guidance" TEXT,
    "sourceRefs" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT,
    "promptSource" TEXT,
    "promptId" TEXT,
    "promptVersion" INTEGER,
    "error" TEXT,
    "requestedById" TEXT,
    "executionTimeoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_topic_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_topic_working_draft" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "postType" "PublishingTopicPostType" NOT NULL,
    "body" TEXT NOT NULL,
    "sourceDraftId" TEXT,
    "sourceOptionLabel" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_topic_working_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_draft_topicId_postType_version_key" ON "publishing_topic_draft"("topicId", "postType", "version");

-- CreateIndex
CREATE INDEX "publishing_topic_draft_topicId_postType_createdAt_idx" ON "publishing_topic_draft"("topicId", "postType", "createdAt");

-- CreateIndex
CREATE INDEX "publishing_topic_draft_projectId_idx" ON "publishing_topic_draft"("projectId");

-- CreateIndex
CREATE INDEX "publishing_topic_draft_organizationId_idx" ON "publishing_topic_draft"("organizationId");

-- CreateIndex
CREATE INDEX "publishing_topic_draft_userId_idx" ON "publishing_topic_draft"("userId");

-- CreateIndex
CREATE INDEX "publishing_topic_draft_requestedById_idx" ON "publishing_topic_draft"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_working_draft_topicId_postType_key" ON "publishing_topic_working_draft"("topicId", "postType");

-- CreateIndex
CREATE INDEX "publishing_topic_working_draft_projectId_idx" ON "publishing_topic_working_draft"("projectId");

-- CreateIndex
CREATE INDEX "publishing_topic_working_draft_organizationId_idx" ON "publishing_topic_working_draft"("organizationId");

-- CreateIndex
CREATE INDEX "publishing_topic_working_draft_userId_idx" ON "publishing_topic_working_draft"("userId");

-- CreateIndex
CREATE INDEX "publishing_topic_working_draft_updatedById_idx" ON "publishing_topic_working_draft"("updatedById");

-- AddForeignKey
ALTER TABLE "publishing_topic_draft" ADD CONSTRAINT "publishing_topic_draft_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_draft" ADD CONSTRAINT "publishing_topic_draft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_draft" ADD CONSTRAINT "publishing_topic_draft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_draft" ADD CONSTRAINT "publishing_topic_draft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_draft" ADD CONSTRAINT "publishing_topic_draft_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_working_draft" ADD CONSTRAINT "publishing_topic_working_draft_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_working_draft" ADD CONSTRAINT "publishing_topic_working_draft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_working_draft" ADD CONSTRAINT "publishing_topic_working_draft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_working_draft" ADD CONSTRAINT "publishing_topic_working_draft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_working_draft" ADD CONSTRAINT "publishing_topic_working_draft_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The things Prisma cannot express.
-- ---------------------------------------------------------------------------

-- In-flight guard: at most ONE generating draft per topic PER CONTENT TYPE.
-- Deliberately not per topic, unlike the sibling
-- `publishing_topic_planning_analysis_active`: a topic has one planning
-- analysis but several content types, and generating a short post while a blog
-- post generates is a thing users will legitimately do.
--
-- The index is the enforcement; the read in the start helper only turns the
-- race into a friendly "in flight" answer instead of a constraint error.
CREATE UNIQUE INDEX "publishing_topic_draft_active"
    ON "publishing_topic_draft" ("topicId", "postType")
    WHERE "status" = 'GENERATING';

-- Parent agreement: a draft's topic must live in the draft's project.
--
-- The plain FKs above prove `topicId` names a real topic and `projectId` a real
-- project — and nothing at all about the two agreeing. A row pairing topic A
-- (project X) with project Y is therefore accepted, and `listTopicDrafts`
-- authorizes the caller against `projectId` and then reads by exactly these two
-- denormalised columns: a caller authorized on Y would receive topic A's draft
-- metadata. Nothing in 2B-1 writes rows, so the window is theoretical today and
-- opens the moment 2B-2 adds a writer — which is precisely why it is closed
-- here, while it costs one index.
--
-- Tenant agreement follows transitively rather than by its own constraint: a
-- project determines its tenant, every writer derives the tuple from the LOCKED
-- project row, and the residual case — a row whose tenant columns went stale
-- after an organization transfer — is the known limitation the transfer note in
-- the 2B-1 design records for the whole publishing family. A composite FK on
-- the nullable tenant pair would not close it either: MATCH SIMPLE treats a
-- NULL column as satisfied, so it would enforce nothing for personal topics.
-- migration-lint: allow unvalidated-constraint — this is the only statement in
-- the migration that touches a PRE-EXISTING table, and it is a UNIQUE, which
-- NOT VALID cannot defer. Three things bound the risk, and the first is what
-- makes this case safer than the `two_factor` precedent that had to reason
-- about the same trade-off:
--   1. THE BUILD CANNOT FAIL ON A DUPLICATE. "id" is already the primary key,
--      so ("id", "projectId") is unique by construction on its first column
--      alone. The INVALID-index hazard that rules out CREATE UNIQUE INDEX
--      CONCURRENTLY elsewhere — a concurrent unique build meeting a duplicate
--      and leaving behind an index that silently enforces nothing — cannot
--      arise here. It is a single-pass build of an index that is guaranteed to
--      succeed.
--   2. The table is not write-hot. It holds one row per AI-suggested publishing
--      topic per project, written by a scheduled suggestion cycle and by manual
--      topic creation — not per request, per event or per user action.
--   3. CONCURRENTLY is unavailable regardless: it cannot run inside Prisma's
--      migration transaction, which is why the sibling migrations that needed
--      it each got their own migration and this one cannot.
-- The alternative is deferring the constraint to a later release, which would
-- mean 2B-2's first writer lands BEFORE the guarantee it depends on — the
-- opposite of the ordering this constraint exists to establish.
ALTER TABLE "publishing_topic"
    ADD CONSTRAINT "publishing_topic_id_project_key"
    UNIQUE ("id", "projectId");

ALTER TABLE "publishing_topic_draft"
    ADD CONSTRAINT "publishing_topic_draft_topic_project_fkey"
    FOREIGN KEY ("topicId", "projectId")
    REFERENCES "publishing_topic" ("id", "projectId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publishing_topic_working_draft"
    ADD CONSTRAINT "publishing_topic_working_draft_topic_project_fkey"
    FOREIGN KEY ("topicId", "projectId")
    REFERENCES "publishing_topic" ("id", "projectId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Referenced by the composite foreign key below. Redundant as a uniqueness
-- claim — "id" is already the primary key — and required anyway: Postgres
-- accepts a composite FK only against a unique constraint covering exactly the
-- referenced column list.
ALTER TABLE "publishing_topic_draft"
    ADD CONSTRAINT "publishing_topic_draft_id_topic_post_type_key"
    UNIQUE ("id", "topicId", "postType");

-- A working draft may only cite a candidate of ITS OWN topic and content type.
-- A single-column FK on "sourceDraftId" would prove the candidate exists and
-- nothing more, leaving a BLOG_POST working draft free to cite a TWEET
-- candidate, or a candidate belonging to another topic entirely. The write
-- helper would have to remember; a helper that has to remember eventually
-- forgets.
--
-- The column list after SET NULL is load-bearing. A bare ON DELETE SET NULL
-- nulls EVERY referencing column, including NOT NULL "topicId" and "postType" —
-- so deleting a candidate would raise a not-null violation and FAIL, the exact
-- opposite of the intent. Restricting the action to ("sourceDraftId") loses the
-- provenance and keeps the body, which is what the working draft is for.
-- Requires PostgreSQL 15+; dev runs 15, CI runs 16.
--
-- MATCH SIMPLE (the default) treats a composite key with any NULL column as
-- satisfied, so a hand-written working draft with no source candidate is legal.
--
-- Prisma models "sourceDraftId" as a plain column, NOT a relation, because it
-- cannot express a subset SET NULL. A shadow-database diff may therefore read
-- this constraint as drift and try to DROP it — the same hazard
-- `publishing_topic_decision_entry_question_root` documents.
--
-- IF YOU ARE READING THIS BECAUSE `prisma migrate dev` PROPOSED DROPPING IT:
-- delete that statement from the generated migration. The drop is not a real
-- schema change, it is Prisma reconciling against a model that cannot express
-- the constraint. Case "2B-1 A" in `publishing-suite-constraints.test.ts` reads
-- this constraint back out of `pg_constraint` and asserts its subset delete
-- action, so shipping the drop turns `db-integration` red rather than silently
-- removing the guarantee.
ALTER TABLE "publishing_topic_working_draft"
    ADD CONSTRAINT "publishing_topic_working_draft_source_draft_fkey"
    FOREIGN KEY ("sourceDraftId", "topicId", "postType")
    REFERENCES "publishing_topic_draft" ("id", "topicId", "postType")
    ON DELETE SET NULL ("sourceDraftId")
    ON UPDATE CASCADE;

-- Strict tenant XOR on both tables, matching `publishing_topic_tenant_xor`.
-- `<>` means EXACTLY one of the two is non-null, so a row with neither is
-- rejected as well. RLS is not a substitute: its organization branch permits any
-- `userId`, it does not require null.
ALTER TABLE "publishing_topic_draft"
    ADD CONSTRAINT "publishing_topic_draft_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

ALTER TABLE "publishing_topic_working_draft"
    ADD CONSTRAINT "publishing_topic_working_draft_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- A GENERATING row must carry its own liveness deadline, matching
-- `publishing_topic_planning_analysis_generating_timeout`. Without it the
-- partial unique index above becomes a PERMANENT lock the moment a worker dies
-- between the insert and the terminal marker: that content type could never be
-- generated again and no user action would recover it. Terminal rows may leave
-- it NULL.
ALTER TABLE "publishing_topic_draft"
    ADD CONSTRAINT "publishing_topic_draft_generating_timeout"
    CHECK ("status" <> 'GENERATING' OR "executionTimeoutAt" IS NOT NULL);

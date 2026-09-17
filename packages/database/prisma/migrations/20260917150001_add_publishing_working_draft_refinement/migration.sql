-- The AI refinement PROPOSAL, held on the working draft it is about
-- (Fizzy #1851 follow-up).
--
-- WHY THIS IS NOT A DRAFT ROW
--
-- "Refine this draft" ran the ordinary generation path, so it inherited the
-- generation contract by accident. For Short Post and LinkedIn that contract is
-- exactly three options (FR16) which the locked clauses require to be
-- meaningfully DISTINCT — so "remove the last line" returned three rewrites, at
-- least two of which had to change something nobody asked for. It also wrote a
-- `publishing_topic_draft` row, which consumed a version number and put a
-- punctuation fix in the candidates grid next to real generations.
--
-- A refinement is a proposal ABOUT the working draft, not a candidate beside
-- it. One result, no version number, nothing in the grid.
--
-- WHY THESE COLUMNS AND NOT A TABLE
--
-- There is at most one proposal in flight per (topicId, postType), which is
-- what `publishing_topic_working_draft_topicId_postType_key` already
-- guarantees. That unique key IS the in-flight lock: the start writer
-- compare-and-sets on "refinementStatus", so this needs neither the partial
-- unique index nor the reclaim query `publishing_topic_draft` needs both of.
--
-- Bare additive and fully nullable. Every existing row is already in the
-- "no proposal" state, so there is nothing to backfill and the previous app
-- version — which never writes these columns — keeps working unchanged.
--
-- NO `refinementStatus <> 'GENERATING' OR refinementExpiresAt IS NOT NULL`
-- CHECK, deliberately, where the sibling table has
-- `publishing_topic_draft_generating_timeout`. There, exclusion is enforced by
-- a partial unique index in the DATABASE, so a null deadline strands the
-- content type permanently and only a constraint can prevent it. Here the rule
-- lives in the start writer and is written fail-OPEN — a GENERATING proposal
-- with a null OR passed deadline is reclaimable — so a missing deadline cannot
-- lock anything, and the constraint would guard an unreachable outcome at the
-- cost of a NOT VALID entry and a later VALIDATE release.

-- CreateEnum
CREATE TYPE "PublishingRefinementStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "publishing_topic_working_draft"
    ADD COLUMN "refinementStatus" "PublishingRefinementStatus",
    -- The CAS token for one run, rebuilding what the attempt row's primary key
    -- gave for free. CASing on status alone is not enough: a stranded run
    -- reclaimed by the next start would still satisfy `status = 'GENERATING'`
    -- and commit its result into the newer run's slot.
    ADD COLUMN "refinementRunId" TEXT,
    -- What the model proposed. Markdown, like "body" — which is what lets one
    -- refine contract serve all seven content types.
    ADD COLUMN "refinedBody" TEXT,
    -- The "body" this proposal was computed against. A staleness guard, not
    -- provenance: the working draft is SHARED, so "A refines from X, B edits to
    -- Y, A accepts" is a live path that would otherwise destroy B's edit.
    ADD COLUMN "refinedFromBody" TEXT,
    ADD COLUMN "refinementInstruction" TEXT,
    ADD COLUMN "refinementError" TEXT,
    -- The model's note about the revision: what it generalized, what it could
    -- not do. Distinct from "refinementError", which means the run FAILED — a
    -- note sits on a perfectly good READY proposal.
    ADD COLUMN "refinementNote" TEXT,
    ADD COLUMN "refinementExpiresAt" TIMESTAMP(3),
    -- The proposal's own poll token. SEPARATE from "updatedAt", which is the
    -- BODY's concurrency token and appears in the WHERE of every body
    -- compare-and-set. Prisma's @updatedAt moves on any update to the row, so a
    -- proposal write that did not pin it would invalidate every open editor's
    -- token and tell a person their own refinement had changed their draft.
    ADD COLUMN "refinementUpdatedAt" TIMESTAMP(3),
    -- Plain column, like "editingUserId" and for the same reason.
    ADD COLUMN "refinementRequestedById" TEXT;

-- No index on "refinementStatus". Nothing scans for proposals: a stranded one is
-- reclaimed by the next start for that (topicId, postType), which the unique key
-- already resolves in one row. An index here would also have to be built
-- CONCURRENTLY in a migration of its own, to buy a scan nobody performs.

-- Duplicate verifier verdicts for Proposal Inbox items.
--
-- The inbox flags an item as a possible duplicate of a roadmap ticket or of
-- another inbox item only after the roadmap scan's verifier has confirmed the
-- pair. `story_duplicate_link` cannot hold those verdicts: both of its sides
-- are stories, and an inbox item is not a story until it is applied.
--
-- One row per item and counterpart, keyed by both sides' verdict hashes; a
-- pair whose hashes no longer match is verified again. Rows go with their
-- proposal (ON DELETE CASCADE). Tenancy is the proposal's: the table gets the
-- `proposal_parent` RLS policy from scripts/apply-rls-direct.ts.
--
-- A failed verification is recorded on the row too (failedAttempts and
-- lastFailedAt, on the texts the hashes name), so a pair that keeps failing
-- waits before it is billed again; `flagged` and `confidence` stay null until
-- the verifier first decides the pair.
--
-- No backfill: an absent row reads as "not verified yet".
CREATE TABLE "proposal_item_duplicate_verdict" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "changeIndex" INTEGER NOT NULL,
    "counterpartKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "counterpartHash" TEXT NOT NULL,
    "flagged" BOOLEAN,
    "linkType" "DuplicateLinkType" NOT NULL DEFAULT 'DUPLICATE',
    "similarity" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_item_duplicate_verdict_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "proposal_item_duplicate_verdict_pair_key" ON "proposal_item_duplicate_verdict"("proposalId", "changeIndex", "counterpartKey");

ALTER TABLE "proposal_item_duplicate_verdict" ADD CONSTRAINT "proposal_item_duplicate_verdict_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

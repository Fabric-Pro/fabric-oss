-- AlterTable
-- Which PendingBacklogProposal this work item was created from, so the roadmap
-- can link back to it (`source = APPROVED_PROPOSAL` only says a proposal made
-- it, not which one). Written atomically as part of the story INSERT.
-- No backfill: existing rows never stored the link anywhere, so it cannot be
-- recovered — NULL correctly means "unknown / not from a proposal".
-- Deliberately a plain column, not a foreign key: proposals get pruned, and an
-- FK would either block that pruning or cascade deletes into work items.
ALTER TABLE "user_story" ADD COLUMN "createdFromProposalId" TEXT;

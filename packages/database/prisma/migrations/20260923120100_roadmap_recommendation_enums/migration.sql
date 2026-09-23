-- AlterEnum
-- One batch of Features recommended from project context, stored as a single
-- proposal in the existing review inbox.
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE IF NOT EXISTS 'ROADMAP_RECOMMENDATION';

-- AlterEnum
-- A work item accepted from such a batch. Neither value is used in this
-- migration: a value added by ALTER TYPE cannot be referenced in the
-- transaction that adds it.
ALTER TYPE "StorySource" ADD VALUE IF NOT EXISTS 'AI_RECOMMENDED';

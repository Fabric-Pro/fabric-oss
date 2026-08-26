-- Duplicate-detection overlap tier:
--  1. New DuplicateLinkType enum + link_type column — a flagged pair is either a
--     genuine DUPLICATE (same underlying work item) or an OVERLAP (same
--     problem/capability, different framing — needs human review). Existing rows
--     were all confirmed by the strict same-work-item verifier, so DUPLICATE is
--     the correct backfill default.
--  2. New NOT_DUPLICATE status value — the verifier's cached negative verdict,
--     never surfaced in the UI, so re-scans stop re-paying the LLM for pairs it
--     already judged distinct.
--  3. verified_content_hash_a/b — the detection-text hashes each side had at the
--     last verification; a verdict (positive or negative) stays valid only while
--     both hashes still match, so editing either story re-verifies the pair.

-- AlterEnum
ALTER TYPE "DuplicateLinkStatus" ADD VALUE 'NOT_DUPLICATE';

-- CreateEnum
CREATE TYPE "DuplicateLinkType" AS ENUM ('DUPLICATE', 'OVERLAP');

-- AlterTable
ALTER TABLE "story_duplicate_link"
  ADD COLUMN "linkType" "DuplicateLinkType" NOT NULL DEFAULT 'DUPLICATE',
  ADD COLUMN "verifiedContentHashA" TEXT,
  ADD COLUMN "verifiedContentHashB" TEXT;

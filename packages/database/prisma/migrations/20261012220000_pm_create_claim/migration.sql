-- PM create claim.
--
-- A PM create for a row is sent only after the caller has taken the row's
-- create claim with a conditional UPDATE: `pmCreateClaimId` is set to a fresh
-- UUID only while it and `externalId` are both null. The claim is cleared by
-- the link write that sets `externalId` (scoped to the same claim), by a
-- definite rejection of the create, or by the user's Unlink & re-create. A
-- claim that is still held on an unlinked row means a PM item may exist that
-- Fabric could not link, so a create path that enforces the claim does not
-- send another create for it.
-- `pmCreateClaimedAt` records when the claim was taken.
--
-- Both columns are nullable with no backfill and no index (every read and
-- write goes through the row's primary key). Additive only: the previous app
-- version ignores both columns. `test_case` gets them now so that enforcing
-- the claim for test cases needs no further migration.

-- AlterTable
ALTER TABLE "test_case" ADD COLUMN     "pmCreateClaimId" TEXT,
ADD COLUMN     "pmCreateClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "pmCreateClaimId" TEXT,
ADD COLUMN     "pmCreateClaimedAt" TIMESTAMP(3);

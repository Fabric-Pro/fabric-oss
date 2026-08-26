-- Server-enforced step-up for the 2FA MANAGEMENT endpoints (issue #2827).
--
-- 1. session.twoFactorStepUpGrantedAt holds a single-use, short-TTL grant
--    minted by a successful second-factor verification and spent by the next
--    2FA management call. Nullable with no default: the previous app version
--    never writes it, and a NULL simply means "no grant", which is the
--    fail-closed reading.
--
-- 2. two_factor.userId becomes unique. Better Auth's initial enable is a
--    read-then-deleteMany-then-create with no constraint behind it, so two
--    concurrent first-time enables can leave two rows for one user. Both the
--    plugin (`adapter.findOne`) and this repo (`findFirst`) then read the row
--    with no defined ordering, which makes "does this account have a verified
--    factor?" answerable two different ways for the same user. The new gate is
--    written as an existence check and is therefore duplicate-safe on its own;
--    the constraint closes the race at the source instead.
--
--    Duplicates are resolved before the index is built, keeping the row that
--    actually represents the account's factor: a verified row beats an
--    unverified one, and among rows of equal standing the highest id wins
--    (ids are cuids, which sort by creation time, so this keeps the newest).

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "twoFactorStepUpGrantedAt" TIMESTAMP(3);

-- migration-lint: allow unbatched-backfill — two_factor holds at most one row per 2FA-enrolled user and duplicates are a rare race artefact, so this DELETE touches a handful of rows at most; it also has to run in the same transaction as the index build below, since a duplicate created between the two would fail the CREATE UNIQUE INDEX and abort the deploy.
-- migration-lint: allow blocking-index — same bound: the build locks a table with one row per enrolled user for the length of a single small index build. CREATE UNIQUE INDEX CONCURRENTLY is not an option here because it cannot run inside Prisma's migration transaction, and a concurrent unique build that meets a duplicate leaves an INVALID index behind that silently enforces nothing.
DELETE FROM "two_factor"
WHERE "id" IN (
    SELECT "id"
    FROM (
        SELECT "id",
               ROW_NUMBER() OVER (
                   PARTITION BY "userId"
                   ORDER BY "verified" DESC, "id" DESC
               ) AS rn
        FROM "two_factor"
    ) ranked
    WHERE ranked.rn > 1
);

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_userId_key" ON "two_factor"("userId");

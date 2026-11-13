-- Time tracking: deleting a user account keeps the time they logged.
--
-- time_entry."userId" becomes nullable and its foreign key changes from
-- ON DELETE CASCADE to ON DELETE SET NULL, so a deleted account no longer
-- erases billing history from time reports. "userNameSnapshot" keeps the
-- author's name, written on every save, so a report still names who logged
-- the time once the account is gone.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: time_entry keeps its `user_owned` RLS policy
-- (scripts/apply-rls-direct.ts). An entry whose author was deleted keeps its
-- "organizationId", so the organization arm still scopes it to its
-- organization; the personal arm compares "userId" = current_user_id(), which
-- is never true for NULL, so such an entry is nobody's own.

-- AlterTable
ALTER TABLE "time_entry" ADD COLUMN "userNameSnapshot" TEXT;

-- AlterTable
ALTER TABLE "time_entry" ALTER COLUMN "userId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "time_entry" DROP CONSTRAINT "time_entry_userId_fkey";

-- AddForeignKey (validated in 20261111180030, so the table is not locked while
-- existing rows are scanned)
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- Backfill the name of every existing entry's author. One bounded pass: the
-- table was created in 20261111120000 and holds only the entries logged since.
UPDATE "time_entry" AS te
SET "userNameSnapshot" = u."name"
FROM "user" AS u
WHERE u."id" = te."userId"
  AND te."userNameSnapshot" IS NULL;

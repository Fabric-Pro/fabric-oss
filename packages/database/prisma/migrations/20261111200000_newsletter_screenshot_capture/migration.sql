-- Release-notes screenshots can be captured automatically from one of the
-- project's environments.
--
-- Settings name the environment and record when an admin confirmed that it
-- shows sample data only. Each send freezes the environment at creation like
-- `screenshotsEnabled`, so a held send keeps capturing from the environment it
-- started with. Every new column is nullable, so existing rows need no backfill
-- and the previous app version keeps working.
--
-- The send's copy has no foreign key on purpose: a deleted environment fails a
-- capture with a reason, it never blocks the send.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: no new table. `newsletter_settings` and `newsletter_send` keep their
-- `user_owned` RLS policies (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "newsletter_settings" ADD COLUMN "screenshotEnvironmentId" TEXT;
ALTER TABLE "newsletter_settings" ADD COLUMN "screenshotSampleDataConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "newsletter_send" ADD COLUMN "screenshotEnvironmentId" TEXT;

-- AddForeignKey (validated in 20261111200030, so the table is not locked while
-- existing rows are scanned; its index is built in 20261111200100)
ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_screenshotEnvironmentId_fkey" FOREIGN KEY ("screenshotEnvironmentId") REFERENCES "project_environment"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

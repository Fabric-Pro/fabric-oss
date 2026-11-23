-- Parlume keeps the bridge's speech telemetry on the session.
--
-- The media bridge counts, for each meeting, how Parlume's speech went: how
-- long it spoke and how long its audio ran out, how fast a stop said aloud
-- silenced it, resumes, realtime fallbacks and Aura retries. It reports the
-- totals on its alarm; the column holds the latest, and the web app logs
-- what each report added for the alert rules.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_meeting_session`, which
-- keeps its policies (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN "speechHealth" JSONB;

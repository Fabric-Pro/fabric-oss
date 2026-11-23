-- One live Parlume bot for each meeting.
--
-- `parlume_meeting_session."meetingKey"`: the meeting the session's stored
-- join link names, as one key for every spelling of that link. The app writes
-- `parlumeMeetingKey(meetingUrl)` when it creates a session.
--
-- `parlume_meeting_session_one_live_per_meeting`: at most one session per
-- organization and key while it is PENDING, JOINING, ACTIVE or LEAVING. A
-- start already takes an advisory lock on the meeting and finds the live
-- session under it by its link; the index is the database's own guarantee.
-- It is partial, so ended sessions keep any number of rows per meeting.
-- Prisma cannot express a partial index, so schema.prisma declares only the
-- column.
--
-- Existing rows keep a null key, which is outside the index. A session lasts
-- at most four hours, and a start finds a live one by its link under the
-- lock, so the sessions live during the deploy are still guarded.
--
-- Rolling deploy: the previous app version writes no key, and a null key is
-- outside the index, so both versions run against this schema.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_meeting_session`, which keeps
-- its policy (scripts/apply-rls-direct.ts).
--
-- migration-lint: allow blocking-index — a partial index that covers only new sessions in a live status (every existing row has a null key), on a table with one row per Parlume invitation.

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN "meetingKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "parlume_meeting_session_one_live_per_meeting"
  ON "parlume_meeting_session" ("organizationId", "meetingKey")
  WHERE "status" IN ('PENDING', 'JOINING', 'ACTIVE', 'LEAVING')
    AND "meetingKey" IS NOT NULL;

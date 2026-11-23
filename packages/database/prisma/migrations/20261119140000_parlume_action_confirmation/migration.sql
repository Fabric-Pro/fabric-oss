-- Parlume proposals confirmed in Fabric.
--
-- A change Parlume is asked for in a meeting is no longer made at once with
-- the inviter's rights. It is stored as a PROPOSED action and posted to the
-- meeting chat with Confirm and Dismiss links. A signed-in member with edit
-- rights confirms or dismisses it on the action page, and a confirmed change
-- runs as that member. The member is recorded on the action, and so is the
-- tag of the proposal's chat post, which the result line names.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on `parlume_action`, which keeps its
-- `user_owned` policy (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_action"
  ADD COLUMN "decidedByUserId" TEXT,
  ADD COLUMN "chatTag" TEXT;

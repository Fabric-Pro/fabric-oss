-- Parlume records when the run of a confirmed change claimed it.
--
-- A member's confirmation moves a proposed change to EXECUTING and starts
-- its workflow. When that start fails ambiguously (a lost reply), the
-- workflow may run all the same. The run now claims the change once, by
-- setting `startedAt`, before it does anything, and the confirmation reopens
-- the proposal only while no run has claimed it. So a change runs at most
-- once, however its start ended.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_action`, which keeps its
-- policy (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_action"
  ADD COLUMN "startedAt" TIMESTAMP(3);

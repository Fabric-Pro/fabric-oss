-- Coding Instructions: the published-snapshot foreign key becomes RESTRICT.
--
-- It was added ON DELETE SET NULL in 20260916120000. That made deleting the
-- published snapshot a silent success: the row went, and the FK quietly
-- cleared "project"."publishedInstructionSnapshotId", leaving the project with
-- no published coding instructions at all. Both delete paths guarded it with a
-- read-then-delete check, which a concurrent publish can win — it moves the
-- pointer onto a snapshot that was selected for deletion moments earlier.
--
-- RESTRICT makes the database the authority instead of that check. The delete
-- of a published snapshot now raises a foreign-key violation, which the
-- procedure maps to the same conflict it already returned and the prune
-- activity treats as "skip this candidate".
--
-- Same NOT VALID -> VALIDATE split as 20260916120000 / 20260916120200, for
-- the same reason: a plain ADD CONSTRAINT ... FOREIGN KEY scans every row of
-- "project" while holding a lock. The replacement is added NOT VALID here, in
-- the same short transaction as the DROP, so the table is never without the
-- constraint; 20260916120400 validates it under ShareUpdateExclusiveLock,
-- which does not block reads or writes. Nothing can violate it: the
-- referencing column only ever holds NULL or the id of a snapshot that
-- exists, which is what the constraint being replaced already enforced.
--
-- The VALIDATE lands in this same release, so there is no entry in
-- prisma/pending-constraint-validations.json — that ledger is for a NOT VALID
-- whose VALIDATE lands in a LATER release.
ALTER TABLE "project" DROP CONSTRAINT "project_publishedInstructionSnapshotId_fkey";

ALTER TABLE "project" ADD CONSTRAINT "project_publishedInstructionSnapshotId_fkey" FOREIGN KEY ("publishedInstructionSnapshotId") REFERENCES "project_instruction_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

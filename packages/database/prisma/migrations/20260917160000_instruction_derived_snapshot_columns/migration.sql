-- Coding Instructions: a snapshot can be DERIVED from an earlier one.
--
-- Editing, adding or deleting a single file in the tab creates a new snapshot
-- seeded from the published one: the changed paths are uploaded, every other
-- path is inherited from the base without the browser sending a byte. Two
-- columns record that, and both are needed at runtime rather than for
-- reporting.
--
-- "project_instruction_snapshot"."baseSnapshotId" is the provenance ("edited
-- from version N") AND the lifecycle interlock: while a derived snapshot is
-- still RECEIVING or VALIDATING its inherited rows point at the BASE's
-- immutable objects, so the delete procedure and the retention prune must
-- refuse to remove a snapshot that is anyone's base. ON DELETE SET NULL,
-- because once the derived snapshot is READY it stands on its own promoted
-- objects and a base ageing out of retention must not take the version it
-- produced with it.
--
-- "project_instruction_snapshot"."baseVersion" is the base's version number at
-- derive time, written once and never updated. It exists because
-- "baseSnapshotId" is ON DELETE SET NULL and therefore cannot answer "was this
-- snapshot derived?" -- a base that is deleted or pruned nulls it, and a
-- derived snapshot that then read itself as a full upload would publish over
-- a newer version and revert it. This column is the durable discriminator the
-- publish fast-forward keys on, and the value the history line renders
-- ("edited from version N") once the base itself is gone. No foreign key: it
-- is a number, not a reference.
--
-- "project_instruction_file"."inheritedFromFileId" is the base's file row this
-- row was copied from. The validation gate reads it to know that a row whose
-- storage key sits outside this snapshot's own prefixes is legitimate, and
-- exactly which key it should be -- a question that cannot be answered by
-- parsing the key, which is the whole reason it is an explicit column.
--
-- Deliberately NOT a foreign key: the base's file rows are deleted when it
-- ages out of retention, long after the derived snapshot stopped depending on
-- them. A SetNull would rewrite thousands of settled rows for nothing, and a
-- Restrict would let a finished edit pin its base in the bucket forever.
--
-- Bare additive and fully nullable. Every existing row is already in the "not
-- derived" state, so there is nothing to backfill, and the previous app
-- version -- which never writes any of these columns -- keeps working
-- unchanged.
--
-- The foreign key is added NOT VALID here and validated in
-- 20260917160002, in the SAME release, so there is no entry in
-- prisma/pending-constraint-validations.json (that ledger is for a NOT VALID
-- whose VALIDATE lands in a LATER release). Nothing can violate it: the column
-- is new and holds NULL on every row.
ALTER TABLE "project_instruction_snapshot" ADD COLUMN "baseSnapshotId" TEXT;

ALTER TABLE "project_instruction_snapshot" ADD COLUMN "baseVersion" INTEGER;

ALTER TABLE "project_instruction_file" ADD COLUMN "inheritedFromFileId" TEXT;

ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_baseSnapshotId_fkey" FOREIGN KEY ("baseSnapshotId") REFERENCES "project_instruction_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

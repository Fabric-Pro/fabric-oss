-- Separate from ADD CONSTRAINT so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning existing instruction snapshots.
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_git_intent_shape";

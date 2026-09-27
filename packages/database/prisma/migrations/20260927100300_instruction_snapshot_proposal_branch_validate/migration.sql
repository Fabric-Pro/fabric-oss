-- Validate the snapshot CHECKs and foreign key that
-- 20260927100000_instruction_proposal_branches added NOT VALID (Fizzy #2738
-- spec §4.1). VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which lets
-- reads and writes continue while it scans. Every existing row holds NULL in
-- every column these read, so each validates trivially; they are already
-- enforced on every insert and update since that migration.
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_withdraw_pair";
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_withdraw_scope";
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_pending_command_pair";
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_pending_command_kind";
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_pending_withdraw_scope";
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_pending_append_intent";
ALTER TABLE "project_instruction_snapshot" VALIDATE CONSTRAINT "project_instruction_snapshot_proposalBranchId_fkey";

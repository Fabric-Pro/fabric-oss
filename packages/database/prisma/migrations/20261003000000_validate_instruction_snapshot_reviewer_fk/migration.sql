-- Validate the reviewer foreign key added NOT VALID in 20260918215032,
-- which shipped in an earlier release. The nullable column started with NULL
-- on existing rows, and the foreign key already enforces subsequent writes.
-- Bound this scan here: preflight timeouts do not carry into migrate deploy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "project_instruction_snapshot"
  VALIDATE CONSTRAINT "project_instruction_snapshot_reviewerUserId_fkey";

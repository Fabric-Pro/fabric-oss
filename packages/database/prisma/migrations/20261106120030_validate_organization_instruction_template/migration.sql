-- Separate from ADD COLUMN/CONSTRAINT so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning existing organizations. The column was
-- added in 20261106120000, so every existing row holds NULL and the scan finds
-- nothing to reject.
ALTER TABLE "organization" VALIDATE CONSTRAINT "organization_instructionTemplateProjectId_fkey";

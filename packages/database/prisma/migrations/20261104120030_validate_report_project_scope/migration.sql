-- Separate from ADD COLUMN/CONSTRAINT so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning existing reports. The column was added
-- in 20261104120000, so every existing row holds NULL and the scan finds
-- nothing to reject.
ALTER TABLE "template_instance" VALIDATE CONSTRAINT "template_instance_projectId_fkey";

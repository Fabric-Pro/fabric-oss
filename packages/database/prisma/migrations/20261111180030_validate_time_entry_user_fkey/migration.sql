-- Separate from the constraint change so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning existing entries. Every existing
-- "userId" already referenced a user under the previous ON DELETE CASCADE
-- key, so the scan finds nothing to reject.
ALTER TABLE "time_entry" VALIDATE CONSTRAINT "time_entry_userId_fkey";

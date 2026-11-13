-- Separate from the constraint change so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning existing settings. The column was added
-- in 20261111200000 and every existing row holds NULL, so the scan finds
-- nothing to reject.
ALTER TABLE "newsletter_settings" VALIDATE CONSTRAINT "newsletter_settings_screenshotEnvironmentId_fkey";

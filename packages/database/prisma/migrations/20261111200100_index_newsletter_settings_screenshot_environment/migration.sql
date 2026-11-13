-- Run outside a transaction: settings remain writable during the index build.
-- Serves the ON DELETE SET NULL lookup when an environment is deleted.
CREATE INDEX CONCURRENTLY "newsletter_settings_screenshotEnvironmentId_idx" ON "newsletter_settings"("screenshotEnvironmentId");

-- Marks an ON_DEPLOY-enrolled document as due because a deployment was seen.
--
-- Deliberately a marker rather than a second dispatch path: the hourly sweep
-- already carries the collision, stale-actor and tenant guards, so a deploy
-- flags the document and the existing sweep does the work with every guard
-- intact.
--
-- Nullable with no default, so no existing row is affected.
ALTER TABLE "document_auto_refresh_settings"
    ADD COLUMN "deployPendingSince" TIMESTAMP(3);

-- The sweep asks for rows that are pending a deploy regardless of when they last
-- refreshed, so this is the access path for that half of the OR.
CREATE INDEX "document_auto_refresh_settings_deployPendingSince_idx"
    ON "document_auto_refresh_settings"("deployPendingSince")
    WHERE "deployPendingSince" IS NOT NULL;

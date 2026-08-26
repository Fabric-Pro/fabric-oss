-- Add Project.autoPushPmSync feature flag (default false).
--
-- When true, the move-story handler enqueues a Temporal push-to-PM
-- workflow for any story with an externalId after a successful status
-- mutation. Default false preserves prior behavior (manual sync only).
--
-- Safe to run on production: pure column addition with a default,
-- no data backfill required, no locks beyond a brief table-level
-- metadata update.

ALTER TABLE "project" ADD COLUMN "autoPushPmSync" BOOLEAN NOT NULL DEFAULT false;

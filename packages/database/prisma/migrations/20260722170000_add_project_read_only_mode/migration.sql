-- Project-level Read-only mode: blocks all outbound writes to
-- connected external sources while enabled. Defaults to disabled, preserving
-- current write behavior for existing and new projects.
ALTER TABLE "project" ADD COLUMN "readOnlyMode" BOOLEAN NOT NULL DEFAULT false;

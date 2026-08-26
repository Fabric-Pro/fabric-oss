-- Which kinds of test a project requires: functional, integration, e2e,
-- security, performance, accessibility.
--
-- The depth tier already decided this, but only inside a prompt string, so a
-- team could read "Standard" and have no way to see or change what it meant.
--
-- Defaults to an EMPTY array, which reads as "follow the depth tier" rather
-- than "require nothing". That is why the default is not the standard tier's
-- three values: backfilling every existing project with a literal list would
-- freeze them at today's meaning of their tier, so a later change to what
-- "Standard" requires would silently skip every project that predates this
-- column. Empty keeps them tracking the tier, which is what they have been
-- doing all along.
ALTER TABLE "project_qa_settings"
  ADD COLUMN "requiredTestTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

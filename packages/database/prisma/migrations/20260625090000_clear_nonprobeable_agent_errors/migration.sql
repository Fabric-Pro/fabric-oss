-- #1685 follow-up: the health monitor no longer probes in-process FABRIC_NATIVE
-- agents or inline agents with no deployment URL (they have no external /health
-- endpoint). Clear the latched false-ERROR state they accumulated before this
-- change so they are not left permanently red — they will simply keep ACTIVE.
UPDATE "registered_agent"
SET "status" = 'ACTIVE',
    "consecutiveHealthFailures" = 0,
    "lastHealthError" = NULL
WHERE "status" = 'ERROR'
  AND (
    "framework" = 'FABRIC_NATIVE'
    OR "deploymentUrl" IS NULL
    OR btrim("deploymentUrl") = ''
  );

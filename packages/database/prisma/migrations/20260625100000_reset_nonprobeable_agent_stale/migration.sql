-- #1685 follow-up #2: non-probeable agents (in-process FABRIC_NATIVE agents and
-- inline agents with no deployment URL) were marked STALE by the staleness
-- sweep after the previous fix stopped probing them. The sweep now excludes
-- them, but rows already flipped to STALE (or ERROR) need a one-time reset back
-- to ACTIVE so they are not left permanently mislabeled.
UPDATE "registered_agent"
SET "status" = 'ACTIVE',
    "consecutiveHealthFailures" = 0,
    "lastHealthError" = NULL
WHERE "status" IN ('STALE', 'ERROR')
  AND (
    "framework" = 'FABRIC_NATIVE'
    OR "deploymentUrl" IS NULL
    OR btrim("deploymentUrl") = ''
  );

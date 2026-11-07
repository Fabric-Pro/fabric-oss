-- Forward-only: preserve the existing receipt invariants while admitting explicit history.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE delivery_signal_source_command DROP CONSTRAINT delivery_source_command_bounds;
ALTER TABLE delivery_signal_source_command ADD CONSTRAINT delivery_source_command_bounds CHECK (
 "requestId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND operation IN ('CONFIGURE','PAUSE','RESUME','DISCONNECT','CAPTURE','CANCEL')
 AND "payloadHash" ~ '^[0-9a-f]{64}$' AND "expectedVersion" IS NOT NULL AND "expectedVersion">0
 AND "grantRevision" IS NOT NULL AND "grantRevision">0
 AND ("workflowId" IS NULL OR char_length("workflowId") BETWEEN 1 AND 200)
 AND ((operation='CAPTURE' AND "workflowId" IS NOT NULL AND "captureMode" IN ('RECENT','CONTINUE','BACKFILL'))
   OR (operation='CANCEL' AND "workflowId" IS NOT NULL AND "captureMode" IS NULL)
   OR (operation IN ('CONFIGURE','PAUSE','RESUME','DISCONNECT') AND "workflowId" IS NULL AND "captureMode" IS NULL))
);
ALTER TABLE delivery_signal_source_command ADD CONSTRAINT delivery_source_capture_window_finite CHECK (
 ("captureWindowStart" IS NULL OR isfinite("captureWindowStart")) AND ("captureWindowEnd" IS NULL OR isfinite("captureWindowEnd"))
);
COMMIT;

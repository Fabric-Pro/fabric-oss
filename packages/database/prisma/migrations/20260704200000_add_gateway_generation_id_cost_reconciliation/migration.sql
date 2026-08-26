-- Actual-cost reconciliation for Vercel-gateway AI calls.
-- gatewayGenerationId: the gateway's generation id, whose real billed total_cost is
--   fetched shortly after the call (GET /v1/generation) and written back.
-- costIsActual: false while a gateway row still holds the initial estimate; flipped
--   true once reconciled (non-gateway rows are written true at insert time).
-- Additive + defaulted, so historical rows are unaffected. The reconciliation sweep
-- is time-bounded, so pre-existing costIsActual=false rows are never re-queried.
ALTER TABLE "ai_usage_log"
  ADD COLUMN IF NOT EXISTS "gatewayGenerationId" TEXT,
  ADD COLUMN IF NOT EXISTS "costIsActual" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "ai_usage_log_costIsActual_createdAt_idx"
  ON "ai_usage_log" ("costIsActual", "createdAt");

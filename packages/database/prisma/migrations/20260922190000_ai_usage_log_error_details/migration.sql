-- Gateway/provider failure attribution (Fizzy #2623).
-- errorStatusCode: the HTTP status code of the failed attempt, when the thrown
--   error carried one (gateway or provider APICallError).
-- errorDetails: a small structured extract of the failure — name/type/code/
--   isRetryable/generationId/routing — never the raw response body, headers,
--   or request values. Populated only for failed rows (success = false).
-- Additive + nullable, so historical rows are unaffected.
ALTER TABLE "ai_usage_log"
  ADD COLUMN IF NOT EXISTS "errorStatusCode" INTEGER,
  ADD COLUMN IF NOT EXISTS "errorDetails" JSONB;

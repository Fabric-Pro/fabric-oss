-- Prompt-cache + reasoning token breakdown on ai_usage_log so cost can be priced
-- at real cache read/write rates instead of charging every input token at 1x.
-- Additive + defaulted → backfills every existing row to 0 (pre-caching baseline),
-- so historical costs are unchanged and the deploy is safe to auto-apply.
ALTER TABLE "ai_usage_log"
  ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reasoningTokens" INTEGER NOT NULL DEFAULT 0;

-- Unified agent interface (Fizzy #2040): remember how much of the interface a
-- user wants exposed, independently of which engine runs.
--
-- Deliberately a plain text column rather than an enum, matching `chatMode`
-- and `reasoningMode` on this table: adding a mode later should not require a
-- coupled schema migration, and the read side already validates against a
-- closed set and falls back to the default on an unknown value.
--
-- NOT NULL with a default, so every existing row lands on 'simple' without a
-- backfill pass. That is the intended behaviour rather than a shortcut: nobody
-- has expressed a preference yet, and simple is the first-run surface.
ALTER TABLE "user_orchestrator_preferences"
  ADD COLUMN "uiMode" TEXT NOT NULL DEFAULT 'simple';

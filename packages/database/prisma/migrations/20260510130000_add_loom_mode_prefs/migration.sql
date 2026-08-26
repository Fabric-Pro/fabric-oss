-- Add Loom (Fabric Agent) UI persistence columns to user_orchestrator_preferences.
-- Backfilled with the same defaults the React state already used, so existing
-- rows behave identically until the user clicks a different mode for the first
-- time. New rows pick up the defaults via the Prisma model.
ALTER TABLE "user_orchestrator_preferences"
  ADD COLUMN "chatMode" TEXT NOT NULL DEFAULT 'orchestrator',
  ADD COLUMN "reasoningMode" TEXT NOT NULL DEFAULT 'balanced';

-- Fizzy #2770 G7: ChatGPT plan tiers read from the sign-in's subscription
-- claims. Enum values on their own, before any column uses them.
ALTER TYPE "ChatGptPlanTier" ADD VALUE IF NOT EXISTS 'FREE';
ALTER TYPE "ChatGptPlanTier" ADD VALUE IF NOT EXISTS 'TEAM';

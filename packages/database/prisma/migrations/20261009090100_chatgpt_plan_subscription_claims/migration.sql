-- Fizzy #2770 G7: what the sign-in's ID token says about the subscription.
-- Additive; existing rows fill in at their next token refresh.
ALTER TABLE "chat_gpt_plan_credential" ADD COLUMN "tier" "ChatGptPlanTier" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "chat_gpt_plan_credential" ADD COLUMN "subscriptionActiveUntil" TIMESTAMP(3);
ALTER TABLE "chat_gpt_plan_org_account" ADD COLUMN "subscriptionActiveUntil" TIMESTAMP(3);

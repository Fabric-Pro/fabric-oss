UPDATE "ai_usage_log"
SET "billingCategory" = CASE
	WHEN "success" = false THEN NULL
	WHEN "providerConfigId" IS NOT NULL THEN 'EXTERNAL_BYOK'::"AiUsageBillingCategory"
	WHEN "provider" = 'VERCEL_GATEWAY' THEN 'INCLUDED_CREDIT'::"AiUsageBillingCategory"
	ELSE 'EXTERNAL_BYOK'::"AiUsageBillingCategory"
END
WHERE "billingCategory" IS NULL;

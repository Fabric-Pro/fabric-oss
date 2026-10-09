-- ChatGPT plan fallback model and live model list (Fizzy #2770 F10/F8).
--
--   `chat_gpt_plan_org_policy.fallbackModel`: the plan model a call retries on
--   once when the plan does not serve the chosen one. Existing rows get the
--   default, GPT-6 Astra, which is what the code retried on before; null means
--   no fallback.
--
--   `chat_gpt_plan_served_model`: the models each plan source's
--   `GET /v1/models` last listed, keyed by source like
--   `chat_gpt_plan_source_state`. No organizationId and so no RLS policy.

-- AlterTable
ALTER TABLE "chat_gpt_plan_org_policy" ADD COLUMN "fallbackModel" TEXT DEFAULT 'gpt-6-astra';

-- CreateTable
CREATE TABLE "chat_gpt_plan_served_model" (
    "sourceKind" "ChatGptPlanSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_served_model_pkey" PRIMARY KEY ("sourceKind","sourceId","slug")
);

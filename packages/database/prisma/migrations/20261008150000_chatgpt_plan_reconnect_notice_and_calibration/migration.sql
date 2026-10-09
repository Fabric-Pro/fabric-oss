-- Fizzy #2770 D4: owners/admins hear when a shared ChatGPT plan account needs reconnecting.

-- Fizzy #2770 D6 fair share: the most of an account's window one member's
-- interactive work may use, as a percent of its budget. Null (every existing
-- row) means no cap.
ALTER TABLE "chat_gpt_plan_org_account" ADD COLUMN "maxMemberSharePct" INTEGER;

-- Fizzy #2770 D6 calibration: what each shared organization account had used
-- of its window when OpenAI refused it, keyed by source like
-- `chat_gpt_plan_source_state`. No organizationId and so no RLS policy.
CREATE TABLE "chat_gpt_plan_budget_observation" (
    "sourceKind" "ChatGptPlanSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_budget_observation_pkey" PRIMARY KEY ("sourceKind","sourceId","windowStart")
);

-- Fizzy #2770: ChatGPT plan usage as OpenAI reports it, and how accurate
-- Fabric's own window estimate is. Additive only: nullable columns, a
-- constant default (catalog-only on PostgreSQL 11+) and one new table.

-- The usage OpenAI last reported for a plan source in its rate-limit headers.
ALTER TABLE "chat_gpt_plan_source_state"
    ADD COLUMN "reportedPrimaryUsedPercent" DOUBLE PRECISION,
    ADD COLUMN "reportedPrimaryWindowMinutes" INTEGER,
    ADD COLUMN "reportedPrimaryResetAt" TIMESTAMP(3),
    ADD COLUMN "reportedSecondaryUsedPercent" DOUBLE PRECISION,
    ADD COLUMN "reportedSecondaryWindowMinutes" INTEGER,
    ADD COLUMN "reportedSecondaryResetAt" TIMESTAMP(3),
    ADD COLUMN "reportedAt" TIMESTAMP(3);

-- A window that reset unrefused past the budget: a lower bound on it. Every
-- existing row is a refusal.
ALTER TABLE "chat_gpt_plan_budget_observation"
    ADD COLUMN "lowerBound" BOOLEAN NOT NULL DEFAULT false;

-- The estimate's accuracy per source and window. Keyed by source like
-- `chat_gpt_plan_budget_observation`: no organizationId and so no RLS policy.
CREATE TABLE "chat_gpt_plan_window_accuracy" (
    "sourceKind" "ChatGptPlanSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "budget" INTEGER NOT NULL,
    "refusedAt" TIMESTAMP(3),
    "refusalEstimatePercent" DOUBLE PRECISION,
    "peakEstimatePercent" DOUBLE PRECISION,
    "settledAt" TIMESTAMP(3),
    "reportedPercent" DOUBLE PRECISION,
    "estimatePercentAtReport" DOUBLE PRECISION,
    "reportedAt" TIMESTAMP(3),
    "maxDriftPoints" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_window_accuracy_pkey" PRIMARY KEY ("sourceKind","sourceId","windowStart")
);

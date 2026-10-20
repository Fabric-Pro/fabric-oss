-- Shared ChatGPT accounts: background work may use all of each window unless
-- an admin limits it ("Allow Fabric to use", Fizzy #3085 FR8). Only the
-- default for new policy rows changes; existing rows keep their stored value,
-- which may have been chosen deliberately.
ALTER TABLE "chat_gpt_plan_org_policy" ALTER COLUMN "headroomPct" SET DEFAULT 0;

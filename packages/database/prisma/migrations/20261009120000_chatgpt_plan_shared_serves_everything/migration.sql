-- Fizzy #2770: a newly shared ChatGPT plan account serves members without a
-- plan as well as background jobs, instead of waiting for an admin to turn
-- members on. Existing accounts keep what an admin chose.
ALTER TABLE "chat_gpt_plan_org_account" ALTER COLUMN "serveInteractive" SET DEFAULT true;

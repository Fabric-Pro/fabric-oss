-- A member's opt-in to run their own work on this personal key while every
-- ChatGPT plan serving it is spent (Fizzy #3085). Additive, with a constant
-- default: a metadata-only change on PostgreSQL 11+, no table rewrite.
ALTER TABLE "user_cloud_provider_config" ADD COLUMN "useWhenPlanSpent" BOOLEAN NOT NULL DEFAULT false;

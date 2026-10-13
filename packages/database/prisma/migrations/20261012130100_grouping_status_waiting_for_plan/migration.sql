-- A finding-grouping run paused for a ChatGPT plan reset (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "GroupingRunStatus" ADD VALUE IF NOT EXISTS 'WAITING_FOR_PLAN';

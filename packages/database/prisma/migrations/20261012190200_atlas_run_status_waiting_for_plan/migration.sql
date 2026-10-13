-- An Atlas run paused for a ChatGPT plan reset (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "AtlasRunStatus" ADD VALUE IF NOT EXISTS 'WAITING_FOR_PLAN';

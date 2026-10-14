-- A scan or finding review paused for a ChatGPT plan reset (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "ScanStatus" ADD VALUE IF NOT EXISTS 'WAITING_FOR_PLAN';

-- New notification types for background work paused or stopped by spent ChatGPT plans (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CHATGPT_PLAN_WORK_PAUSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CHATGPT_PLAN_WORK_STOPPED';

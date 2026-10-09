-- New notification type for a shared ChatGPT plan account that needs reconnecting (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT';

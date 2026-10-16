-- New notification types for an unattended scheduled workflow run: its first success and every failure (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORKFLOW_RUN_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORKFLOW_RUN_FAILED';

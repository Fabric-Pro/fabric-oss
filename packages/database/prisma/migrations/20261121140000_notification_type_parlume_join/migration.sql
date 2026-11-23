-- New notification types for a Parlume bot that could not join its meeting and
-- for one waiting in the meeting's lobby (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARLUME_JOIN_FAILED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARLUME_WAITING_IN_LOBBY';

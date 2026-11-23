-- Parlume values for a question asked on the Parlume page, answered only
-- there, and for the notification that a meeting's notes are ready (own
-- migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "parlume_meeting_reply_channel" ADD VALUE IF NOT EXISTS 'PAGE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARLUME_NOTES_READY';

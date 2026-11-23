-- Parlume end reason for a meeting it left because someone in it could not be
-- confirmed as able to read the project, or its chat was a Teams channel's
-- (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "parlume_meeting_end_reason" ADD VALUE IF NOT EXISTS 'ATTENDEE_NOT_AUTHORIZED';

-- Parlume values for a stopped answer and for the pause marker in a
-- transcript (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "parlume_meeting_turn_status" ADD VALUE IF NOT EXISTS 'STOPPED';
ALTER TYPE "parlume_meeting_segment_source" ADD VALUE IF NOT EXISTS 'EVENT';

-- Parlume end reason for a meeting it left because an external guest joined
-- (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "parlume_meeting_end_reason" ADD VALUE IF NOT EXISTS 'EXTERNAL_GUEST';

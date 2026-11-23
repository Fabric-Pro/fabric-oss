-- Parlume stop cause for a stop phrase said aloud in the meeting ("Parlume,
-- stop", or a bare "stop"), which ends the answer as a typed stop does
-- (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "parlume_stop_cause" ADD VALUE IF NOT EXISTS 'VOICE';

-- Calendar meetings become time evidence: a Teams meeting in a member's own
-- Microsoft 365 calendar that they organized, accepted or marked tentative, on the project its
-- series is linked to. Stored as a hash of the calendar event id and its start
-- and end only.
--
-- ALTER TYPE ... ADD VALUE is a one-way door: it does not roll back. Safe
-- inside the migration transaction on PostgreSQL 12+, because nothing here
-- uses the new value. Additive and idempotent. No backfill.
ALTER TYPE "TimeEvidenceKind" ADD VALUE IF NOT EXISTS 'CALENDAR_EVENT';

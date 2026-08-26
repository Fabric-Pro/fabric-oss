-- Add WEEKLY to the AiUsageLimitWindow enum so usage limits can be scoped
-- to a calendar week (Mon-Sun in the tenant's IANA timezone).
--
-- `ADD VALUE IF NOT EXISTS` is non-transactional but idempotent — safe to
-- re-run on environments that already have the value.
ALTER TYPE "AiUsageLimitWindow" ADD VALUE IF NOT EXISTS 'WEEKLY';

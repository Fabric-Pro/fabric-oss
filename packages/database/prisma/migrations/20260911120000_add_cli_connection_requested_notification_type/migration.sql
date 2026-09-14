-- CLI connection nudge — ask a teammate to connect a coding CLI (Fizzy #2457).
--
-- Schema delta:
--   * NotificationType += CLI_CONNECTION_REQUESTED (additive — existing
--     consumers ignore unknown enum values, and no existing row changes type).
--     Written by `fanOut.cliConnectionRequested` when a viewer of a project's
--     CLI-connection prompt asks named teammates, or the holders of a function
--     tag on that project, to set one up. Reuses the MENTION category so the
--     recipient's existing "mentions" toggle can silence it.

-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CLI_CONNECTION_REQUESTED';

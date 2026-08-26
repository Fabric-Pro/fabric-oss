-- Report-run completion notifications.
--
-- Schema delta:
--   * NotificationType += REPORT_COMPLETED, REPORT_FAILED (additive — existing
--     consumers ignore unknown enum values).
--   * template_instance_execution.notificationEmittedAt (TIMESTAMP, nullable) —
--     the per-execution idempotency claim set atomically with the notification row.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.


ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REPORT_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REPORT_FAILED';

-- AlterTable
-- `IF NOT EXISTS` matches the idempotency of the ADD VALUE lines above, so a
-- half-applied deploy can re-run this migration cleanly.
ALTER TABLE "template_instance_execution" ADD COLUMN IF NOT EXISTS "notificationEmittedAt" TIMESTAMP(3);

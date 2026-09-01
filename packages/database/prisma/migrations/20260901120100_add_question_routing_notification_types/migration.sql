-- AlterEnum
-- Notification kinds for maturation question routing (Fizzy #1751).
--
-- QUESTION_ASSIGNED and QUESTION_MENTIONED are deliberately separate types rather
-- than one "mention" type: assignment is a request (someone is waiting on you),
-- while a mention raised by an answer that merely cited you needs nothing back.
-- The recipient must be able to tell those apart, so they carry different copy
-- and different categories (ASSIGNMENT vs MENTION).
--
-- Kept in its own migration, mirroring 20260825120000_add_pm_attachment_sync_failed_notification:
-- a value added by ALTER TYPE cannot be referenced in the same transaction that adds it.
-- Reuses the existing ASSIGNMENT / MENTION / REPLY NotificationCategory values, so no
-- category enum change is required.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'QUESTION_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'QUESTION_MENTIONED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'QUESTION_ANSWERED';

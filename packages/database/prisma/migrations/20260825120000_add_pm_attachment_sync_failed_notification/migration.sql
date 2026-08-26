-- AlterEnum
-- Adds the notification type emitted when one or more attachments fail to
-- upload during a PM push (Fizzy #1745, AC-4/AC-10 — see
-- packages/temporal/src/activities/pm-integration/gitlab-rest-story-sync.ts).
-- Reuses the existing `PROJECT` NotificationCategory, so no category enum
-- change is required.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PM_ATTACHMENT_SYNC_FAILED';

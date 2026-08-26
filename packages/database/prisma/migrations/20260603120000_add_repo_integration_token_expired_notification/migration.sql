-- AlterEnum
-- Adds the notification type emitted when a project repository integration's
-- credentials expire and auto-refresh cannot recover (see
-- packages/temporal/src/activities/repo-health-check.ts). Reuses the existing
-- `PROJECT` NotificationCategory, so no category enum change is required.
ALTER TYPE "NotificationType" ADD VALUE 'REPO_INTEGRATION_TOKEN_EXPIRED';

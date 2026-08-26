-- AlterTable: Project Invitation Welcome Widget dismissal
ALTER TABLE "project_user_preference"
  ADD COLUMN "inviteWidgetDismissedAt" TIMESTAMP(3),
  ADD COLUMN "inviteWidgetDismissedInviteExpiry" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "mfaPromptDismissedAt" TIMESTAMP(3),
ADD COLUMN     "mfaPromptSnoozedUntil" TIMESTAMP(3);

-- AlterTable: team-wide pin for decisions (pinned sort to the top)
ALTER TABLE "architecture_decision" ADD COLUMN "pinnedAt" TIMESTAMP(3);

-- AlterTable: per-user Architecture Decision Log view preference (list vs table)
ALTER TABLE "project_user_preference" ADD COLUMN "decisionsView" JSONB;

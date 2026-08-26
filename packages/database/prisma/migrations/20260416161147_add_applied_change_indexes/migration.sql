-- AlterTable
ALTER TABLE "pending_backlog_proposal" ADD COLUMN     "appliedChangeIndexes" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

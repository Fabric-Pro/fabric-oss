-- AlterEnum
ALTER TYPE "KanbanQueueStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "kanban_queue" ADD COLUMN     "branch_name" TEXT,
ADD COLUMN     "completed_at" TIMESTAMP(3);

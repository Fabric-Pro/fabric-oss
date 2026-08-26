-- CreateEnum
CREATE TYPE "KanbanQueueStatus" AS ENUM ('PENDING', 'PULLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "kanban_queue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdById" TEXT NOT NULL,
    "status" "KanbanQueueStatus" NOT NULL DEFAULT 'PENDING',
    "context" JSONB NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pulled_at" TIMESTAMP(3),

    CONSTRAINT "kanban_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kanban_queue_projectId_status_idx" ON "kanban_queue"("projectId", "status");

-- CreateIndex
CREATE INDEX "kanban_queue_storyId_idx" ON "kanban_queue"("storyId");

-- CreateIndex
CREATE INDEX "kanban_queue_organizationId_idx" ON "kanban_queue"("organizationId");

-- AddForeignKey
ALTER TABLE "kanban_queue" ADD CONSTRAINT "kanban_queue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_queue" ADD CONSTRAINT "kanban_queue_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_queue" ADD CONSTRAINT "kanban_queue_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_queue" ADD CONSTRAINT "kanban_queue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

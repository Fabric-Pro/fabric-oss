-- AlterTable
-- Cancellation audit for report executions: who cancelled and when. cancelledBy may
-- differ from userId when an organization admin/owner cancels another member's run.
ALTER TABLE "template_instance_execution" ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3);

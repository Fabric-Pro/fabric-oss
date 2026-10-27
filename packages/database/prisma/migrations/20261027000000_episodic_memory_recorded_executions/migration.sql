-- AlterTable
ALTER TABLE "episodic_memory" ADD COLUMN     "recordedExecutionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "turnSections" JSONB NOT NULL DEFAULT '{}';


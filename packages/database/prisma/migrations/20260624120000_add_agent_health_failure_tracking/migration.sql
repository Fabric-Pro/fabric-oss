-- AlterTable
ALTER TABLE "registered_agent" ADD COLUMN "consecutiveHealthFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastHealthError" TEXT;

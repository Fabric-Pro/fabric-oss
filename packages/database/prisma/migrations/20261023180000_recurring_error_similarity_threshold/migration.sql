-- Recurring-error detection: the minimum judge confidence at which two errors,
-- or an error and an open bug, count as the same problem. 0.7 is the value the
-- scan used before it became configurable.

-- AlterTable
ALTER TABLE "project" ADD COLUMN "recurringErrorSimilarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7;

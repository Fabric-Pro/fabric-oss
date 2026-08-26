-- AlterTable
ALTER TABLE "two_factor" ADD COLUMN     "stepUpFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stepUpLockedUntil" TIMESTAMP(3),
ADD COLUMN     "stepUpEpoch" INTEGER NOT NULL DEFAULT 0;

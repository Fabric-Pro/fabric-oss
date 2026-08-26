-- AlterTable: add permissions array to session
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

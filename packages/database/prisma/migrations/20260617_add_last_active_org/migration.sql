-- Add lastActiveOrganizationId to User model to persist the last active workspace
-- across login sessions for faster UX.

-- AlterTable
ALTER TABLE "user" ADD COLUMN "lastActiveOrganizationId" TEXT;

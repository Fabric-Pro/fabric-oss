-- CreateEnum
CREATE TYPE "TemplateInstanceStatus" AS ENUM ('PENDING', 'ACTIVE', 'ARCHIVED', 'DRAFT');

-- AlterTable: Add versioning columns to template_instance
-- First add columns as nullable
ALTER TABLE "template_instance" ADD COLUMN "sId" TEXT;
ALTER TABLE "template_instance" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "template_instance" ADD COLUMN "status" "TemplateInstanceStatus" NOT NULL DEFAULT 'ACTIVE';

-- Populate sId for existing rows with unique values (using gen_random_uuid as a proxy for cuid)
UPDATE "template_instance" SET "sId" = gen_random_uuid()::text WHERE "sId" IS NULL;

-- Now set sId to NOT NULL
ALTER TABLE "template_instance" ALTER COLUMN "sId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "template_instance_sId_idx" ON "template_instance"("sId");

-- CreateIndex
CREATE INDEX "template_instance_status_idx" ON "template_instance"("status");

-- CreateIndex
CREATE UNIQUE INDEX "template_instance_sId_version_key" ON "template_instance"("sId", "version");

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ScheduleMode" AS ENUM ('INHERITED', 'CUSTOM', 'OFF');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AlterTable
ALTER TABLE "template_instance" ADD COLUMN IF NOT EXISTS "scheduleMode" "ScheduleMode" NOT NULL DEFAULT 'INHERITED';

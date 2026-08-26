-- CreateEnum: scan mode (full re-scan vs incremental "changed since last scan").
CREATE TYPE "ScanMode" AS ENUM ('FULL', 'INCREMENTAL');

-- AlterTable: record which mode a scan ran in (drives history + carry-forward).
ALTER TABLE "project_scan" ADD COLUMN "mode" "ScanMode" NOT NULL DEFAULT 'FULL';

-- AlterTable: opt-in git-history secret scan (full clone + gitleaks over commits).
ALTER TABLE "project_scan_config" ADD COLUMN "gitHistoryEnabled" BOOLEAN NOT NULL DEFAULT false;

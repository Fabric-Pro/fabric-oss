-- Per-branch scanning: let a project pin which git branch the repo-based
-- scanners (Semgrep SAST + git-history secrets) clone/scan, and record which
-- branch each scan ran against. Both columns are nullable/additive — a null
-- ProjectScanConfig.scanBranch falls back to the repository's default branch
-- (current behavior), and legacy scans keep a null branch.

-- AlterTable
ALTER TABLE "project_scan_config" ADD COLUMN "scanBranch" TEXT;

-- AlterTable
ALTER TABLE "project_scan" ADD COLUMN "branch" TEXT;

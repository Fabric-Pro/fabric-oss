-- AlterTable: opt-in toggle for the Semgrep SAST code scan (project scope).
ALTER TABLE "project_scan_config" ADD COLUMN "semgrepEnabled" BOOLEAN NOT NULL DEFAULT false;

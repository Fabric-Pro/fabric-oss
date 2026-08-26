-- Feed the adversarial false-positive judge real evidence, and let a project
-- turn the auto-review off. Both columns are additive/nullable-or-defaulted so
-- the change is backward compatible.

-- AlterTable: a short, redacted source excerpt grounding each finding (Semgrep
-- matched lines / gitleaks rule+location / AI-scanner cited quote). Null on
-- legacy rows.
ALTER TABLE "scan_finding" ADD COLUMN "evidence" TEXT;

-- AlterTable: opt-out for the auto-run false-positive review (on by default).
ALTER TABLE "project_scan_config" ADD COLUMN "autoReviewFindings" BOOLEAN NOT NULL DEFAULT true;

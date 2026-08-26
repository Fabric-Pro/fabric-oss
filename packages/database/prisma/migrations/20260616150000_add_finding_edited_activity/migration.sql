-- AlterEnum: new activity type for finding triage edits (status/category/severity).
-- Additive and not used within this migration's transaction, so it is safe on
-- PostgreSQL 12+ (mirrors the earlier StorySource.SECURITY_SCAN add).
ALTER TYPE "ScanActivityType" ADD VALUE 'FINDING_EDITED';

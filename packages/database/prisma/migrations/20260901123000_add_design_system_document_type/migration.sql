-- Add Design System Markdown documents as a first-class project document type.
-- PostgreSQL enum additions are intentionally additive and cannot be safely
-- removed while rows may reference the value. IF NOT EXISTS makes recovery
-- from a partially applied deployment idempotent, matching newer enum migrations.
ALTER TYPE "ProjectDocumentType" ADD VALUE IF NOT EXISTS 'DESIGN_SYSTEM';

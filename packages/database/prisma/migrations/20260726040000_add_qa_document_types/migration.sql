-- QA hardening phase 5 — the QA document types the QA capability mocks call for
-- (Test Plan, Test Report, Traceability Matrix snapshot).
--
-- ProjectDocumentType previously carried QA_STRATEGY alone, so the other QA
-- artifacts had nowhere to live as first-class, versioned documents.
--
-- Additive enum values, matching the house style for enum migrations (see the
-- SRS addition). `IF NOT EXISTS` keeps this idempotent across re-runs and a
-- freshly-seeded database.
--
-- NOTE: Postgres cannot add an enum value inside a transaction block that then
-- USES it in the same transaction; these are pure ALTERs with no dependent DML,
-- so the standard migration transaction is fine.

ALTER TYPE "ProjectDocumentType" ADD VALUE IF NOT EXISTS 'TEST_PLAN';
ALTER TYPE "ProjectDocumentType" ADD VALUE IF NOT EXISTS 'TEST_REPORT';
ALTER TYPE "ProjectDocumentType" ADD VALUE IF NOT EXISTS 'TRACEABILITY_MATRIX';

-- migration-lint: allow destructive-without-marker — The matching unique index retains lookup coverage and uniqueness for both application versions.
DROP INDEX CONCURRENTLY "document_lock_documentId_idx";

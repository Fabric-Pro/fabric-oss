-- migration-lint: allow destructive-without-marker — The matching unique index retains lookup coverage and uniqueness for both application versions.
DROP INDEX CONCURRENTLY "template_instance_artifact_chunk_qdrantId_idx";

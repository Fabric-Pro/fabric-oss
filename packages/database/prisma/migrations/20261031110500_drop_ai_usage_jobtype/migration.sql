-- migration-lint: allow destructive-without-marker — The preceding partial index retains non-null origin/job lookups; no application query filters this column for null.
DROP INDEX CONCURRENTLY "ai_usage_log_jobType_createdAt_idx";

-- Codex F1 (tenant-XOR) + F2 (GENERATING liveness deadline) DB-level CHECK constraints for
-- the Publishing Suite tables. Deferred from Plan 1 (PR #2035) to Plan 2. Prisma cannot model
-- arbitrary CHECK constraints, so this migration is hand-authored (mirrors Plan 1's hand-appended
-- partial-unique active-cycle index) and applied via `prisma migrate deploy`. The tables carry no
-- production rows yet, so the constraints validate immediately without NOT VALID.

-- F1: strict tenant-XOR — exactly one of (organizationId, userId) is non-null. The engine
-- normalizes org context -> userId NULL and personal context -> organizationId NULL, so strict
-- XOR holds for BOTH tables (unlike tables that intentionally populate both IDs).
ALTER TABLE "publishing_suggestion_cycle"
  ADD CONSTRAINT "publishing_suggestion_cycle_tenant_xor"
  CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

ALTER TABLE "publishing_topic"
  ADD CONSTRAINT "publishing_topic_tenant_xor"
  CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- F2: a GENERATING cycle must carry an executionTimeoutAt (the liveness-reclaim deadline the
-- dispatcher uses to reclaim orphaned runs). Terminal states may leave it NULL.
ALTER TABLE "publishing_suggestion_cycle"
  ADD CONSTRAINT "publishing_suggestion_cycle_generating_timeout"
  CHECK ("status" <> 'GENERATING' OR "executionTimeoutAt" IS NOT NULL);

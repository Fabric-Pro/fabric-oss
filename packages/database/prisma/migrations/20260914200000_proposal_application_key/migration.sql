-- Idempotency key for rows created by applying a backlog proposal change
-- ("proposal:<proposalId>:<changeIndex>"). Closes the crash window between
-- creating a story and recording its application (plan §F3).
-- fabric-dev has no Feature/Epic container tables; only user_story is keyed.

ALTER TABLE "user_story" ADD COLUMN "proposalApplicationKey" TEXT;

-- migration-lint: allow blocking-index — PARTIAL UNIQUE index on a column this
-- migration just added: every row is NULL at deploy time, so the predicate
-- matches nothing and the build is instantaneous. A concurrent unique build is
-- not used because it cannot run inside Prisma's migration transaction and would
-- leave an INVALID index behind on a duplicate (precedent: 20260816140000).
CREATE UNIQUE INDEX "user_story_proposal_application_key_uq"
  ON "user_story" ("proposalApplicationKey") WHERE "proposalApplicationKey" IS NOT NULL;

-- Proposing an existing prompt as the default for one or more actions.
--
-- Fizzy #2068 FR15-FR18, FR22, FR23.
--
-- A new table rather than reusing prompt_change_request. That model proposes new
-- CONTENT for a prompt; this proposes an existing prompt for a ROLE. They share
-- a status column and nothing else: a nomination carries a target tier, a set of
-- actions, and an AI summary, none of which a change request has, and it does
-- not carry proposed/original content, which is all a change request is.
-- Overloading one table would leave every reader working out which kind of row
-- they are holding. prompt_change_request is left untouched here — it has no
-- code referencing it at all, and deciding its fate is its own change.
--
-- `targets` is jsonb rather than a child table on purpose: the set is written
-- once, read as a unit, and replaced wholesale by the reviewer before approval
-- (FR23). Nothing queries a nomination BY target, so a join table would add a
-- second write path to maintain for no read it serves.
--
-- CREATE TYPE and CREATE TABLE are both additive and safe inside the standard
-- migration transaction. Nothing writes rows until the API ships.
CREATE TYPE "PromptNominationStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'DECLINED',
  'WITHDRAWN',
  'SUPERSEDED'
);

CREATE TABLE "prompt_nomination" (
  "id"              TEXT NOT NULL,
  "promptVersionId" TEXT NOT NULL,
  "nominatedById"   TEXT NOT NULL,
  "targetScope"     "PromptScope" NOT NULL,
  "organizationId"  TEXT,
  "targets"         JSONB NOT NULL,
  "changeSummary"   TEXT,
  "summaryDegraded" BOOLEAN NOT NULL DEFAULT false,
  "status"          "PromptNominationStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedById"    TEXT,
  "reviewedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prompt_nomination_pkey" PRIMARY KEY ("id")
);

-- The reviewer's queue: pending nominations for one tier, and for an org admin,
-- pending nominations for their organization.
CREATE INDEX "prompt_nomination_status_targetScope_idx"
  ON "prompt_nomination" ("status", "targetScope");
CREATE INDEX "prompt_nomination_organizationId_status_idx"
  ON "prompt_nomination" ("organizationId", "status");
CREATE INDEX "prompt_nomination_promptVersionId_idx"
  ON "prompt_nomination" ("promptVersionId");
CREATE INDEX "prompt_nomination_nominatedById_idx"
  ON "prompt_nomination" ("nominatedById");

ALTER TABLE "prompt_nomination"
  ADD CONSTRAINT "prompt_nomination_promptVersionId_fkey"
  FOREIGN KEY ("promptVersionId") REFERENCES "prompt_version"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_nomination"
  ADD CONSTRAINT "prompt_nomination_nominatedById_fkey"
  FOREIGN KEY ("nominatedById") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The reviewer may leave; the record of the decision should not vanish with them.
ALTER TABLE "prompt_nomination"
  ADD CONSTRAINT "prompt_nomination_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "prompt_nomination"
  ADD CONSTRAINT "prompt_nomination_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

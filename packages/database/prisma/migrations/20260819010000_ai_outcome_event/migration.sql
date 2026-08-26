-- AI adoption analytics, Phase 2 (Fizzy #2230): one human verdict on one piece
-- of AI-generated output. Written from the mutation that handles the human's
-- action, minutes after the model call and in a different request, which is why
-- it cannot live on the ai_usage_log row.
--
-- modelCanonicalName / promptVersionId are snapshots taken at write time: the
-- table exists to compare acceptance across model and prompt changes, so
-- resolving "which prompt is bound" at read time would answer for today rather
-- than for when the output was produced.
CREATE TYPE "ai_outcome_kind" AS ENUM ('ACCEPTED_AS_IS', 'ACCEPTED_WITH_EDITS', 'REJECTED', 'RATED_UP', 'RATED_DOWN');

CREATE TABLE "ai_outcome_event" (
    "id" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "outcome" "ai_outcome_kind" NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "modelCanonicalName" TEXT,
    "promptVersionId" TEXT,
    "comment" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_outcome_event_pkey" PRIMARY KEY ("id")
);

-- One verdict per person per thing: re-rating updates in place, so a user
-- toggling up then down leaves one row rather than two contradictory ones.
CREATE UNIQUE INDEX "ai_outcome_event_featureKey_subjectType_subjectId_userId_key" ON "ai_outcome_event"("featureKey", "subjectType", "subjectId", "userId");

CREATE INDEX "ai_outcome_event_featureKey_createdAt_idx" ON "ai_outcome_event"("featureKey", "createdAt");
CREATE INDEX "ai_outcome_event_organizationId_createdAt_idx" ON "ai_outcome_event"("organizationId", "createdAt");
CREATE INDEX "ai_outcome_event_projectId_createdAt_idx" ON "ai_outcome_event"("projectId", "createdAt");
CREATE INDEX "ai_outcome_event_modelCanonicalName_createdAt_idx" ON "ai_outcome_event"("modelCanonicalName", "createdAt");

ALTER TABLE "ai_outcome_event" ADD CONSTRAINT "ai_outcome_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_outcome_event" ADD CONSTRAINT "ai_outcome_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_outcome_event" ADD CONSTRAINT "ai_outcome_event_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One person's QA approval of one feature, plus the per-project threshold that
-- decides how many are required before a feature may be marked DONE.
--
-- The threshold defaults to 0, which disables the gate, so no existing project
-- changes behaviour on deploy.

CREATE TABLE "qa_sign_off" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userStoryId" TEXT NOT NULL,
    "signedById" TEXT NOT NULL,
    "signedByLabel" TEXT NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_sign_off_pkey" PRIMARY KEY ("id")
);

-- The control itself: one approval per person per feature. Without this,
-- "two sign-offs required" is satisfiable by one person pressing the button
-- twice, which is the whole assurance the setting is meant to buy.
CREATE UNIQUE INDEX "qa_sign_off_userStoryId_signedById_key"
    ON "qa_sign_off"("userStoryId", "signedById");

CREATE INDEX "qa_sign_off_userStoryId_createdAt_idx"
    ON "qa_sign_off"("userStoryId", "createdAt" DESC);

CREATE INDEX "qa_sign_off_projectId_idx" ON "qa_sign_off"("projectId");
CREATE INDEX "qa_sign_off_userId_idx" ON "qa_sign_off"("userId");
CREATE INDEX "qa_sign_off_organizationId_idx" ON "qa_sign_off"("organizationId");

ALTER TABLE "qa_sign_off"
    ADD CONSTRAINT "qa_sign_off_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "qa_sign_off"
    ADD CONSTRAINT "qa_sign_off_userStoryId_fkey"
    FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "qa_sign_off"
    ADD CONSTRAINT "qa_sign_off_signedById_fkey"
    FOREIGN KEY ("signedById") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "qa_sign_off"
    ADD CONSTRAINT "qa_sign_off_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "qa_sign_off"
    ADD CONSTRAINT "qa_sign_off_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 0 = gate disabled. Chosen so this migration is behaviour-neutral.
ALTER TABLE "project_qa_settings"
    ADD COLUMN "requiredQaSignOffs" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "daily_brief_release_note_exclusion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "repoFullName" TEXT,
    "prNumber" INTEGER,
    "storyIdentifier" TEXT,
    "reason" TEXT,
    "excludedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_brief_release_note_exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_brief_release_note_exclusion_projectId_idx" ON "daily_brief_release_note_exclusion"("projectId");

-- CreateIndex
CREATE INDEX "daily_brief_release_note_exclusion_organizationId_idx" ON "daily_brief_release_note_exclusion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_brief_release_note_exclusion_projectId_targetKey_key" ON "daily_brief_release_note_exclusion"("projectId", "targetKey");

-- AddForeignKey
ALTER TABLE "daily_brief_release_note_exclusion" ADD CONSTRAINT "daily_brief_release_note_exclusion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief_release_note_exclusion" ADD CONSTRAINT "daily_brief_release_note_exclusion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief_release_note_exclusion" ADD CONSTRAINT "daily_brief_release_note_exclusion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

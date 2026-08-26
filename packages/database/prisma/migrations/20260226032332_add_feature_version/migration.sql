-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "feature_version" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT,
    "acceptanceCriteria" TEXT,
    "draftingStage" "FeatureDraftingStage" NOT NULL,
    "changeDescription" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "feature_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_version_storyId_version_idx" ON "feature_version"("storyId", "version");

-- CreateIndex
CREATE INDEX "feature_version_userId_idx" ON "feature_version"("userId");

-- CreateIndex
CREATE INDEX "feature_version_organizationId_idx" ON "feature_version"("organizationId");

-- AddForeignKey
ALTER TABLE "feature_version" ADD CONSTRAINT "feature_version_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_version" ADD CONSTRAINT "feature_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_version" ADD CONSTRAINT "feature_version_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

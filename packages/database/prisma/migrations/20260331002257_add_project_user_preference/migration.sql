-- CreateTable
CREATE TABLE "project_user_preference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "kanbanLocalRepoPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_user_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_user_preference_projectId_idx" ON "project_user_preference"("projectId");

-- CreateIndex
CREATE INDEX "project_user_preference_userId_idx" ON "project_user_preference"("userId");

-- CreateIndex
CREATE INDEX "project_user_preference_organizationId_idx" ON "project_user_preference"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_user_preference_projectId_userId_key" ON "project_user_preference"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "project_user_preference" ADD CONSTRAINT "project_user_preference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_user_preference" ADD CONSTRAINT "project_user_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_user_preference" ADD CONSTRAINT "project_user_preference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

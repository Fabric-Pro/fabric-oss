-- CreateTable
CREATE TABLE "project_transcript_folder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webUrl" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "discoveredAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,

    CONSTRAINT "project_transcript_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_transcript_folder_file" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "driveItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "contextId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,

    CONSTRAINT "project_transcript_folder_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_transcript_folder_projectId_idx" ON "project_transcript_folder"("projectId");

-- CreateIndex
CREATE INDEX "project_transcript_folder_userId_idx" ON "project_transcript_folder"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_transcript_folder_projectId_driveId_itemId_key" ON "project_transcript_folder"("projectId", "driveId", "itemId");

-- CreateIndex
CREATE INDEX "project_transcript_folder_file_projectId_status_idx" ON "project_transcript_folder_file"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_transcript_folder_file_userId_idx" ON "project_transcript_folder_file"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_transcript_folder_file_folderId_driveItemId_key" ON "project_transcript_folder_file"("folderId", "driveItemId");

-- AddForeignKey
ALTER TABLE "project_transcript_folder" ADD CONSTRAINT "project_transcript_folder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transcript_folder" ADD CONSTRAINT "project_transcript_folder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transcript_folder" ADD CONSTRAINT "project_transcript_folder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transcript_folder_file" ADD CONSTRAINT "project_transcript_folder_file_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "project_transcript_folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transcript_folder_file" ADD CONSTRAINT "project_transcript_folder_file_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transcript_folder_file" ADD CONSTRAINT "project_transcript_folder_file_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transcript_folder_file" ADD CONSTRAINT "project_transcript_folder_file_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


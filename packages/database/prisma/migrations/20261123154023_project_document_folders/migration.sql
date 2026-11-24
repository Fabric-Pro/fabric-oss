-- OneDrive and SharePoint document folders (Fizzy #2808).
-- project_document_folder: a folder a project imports files from as ordinary
-- project context, read with its reader's Microsoft connection.
-- project_document_folder_file: one file seen in such a folder and what became
-- of it. Both are new and empty, so their indexes build without a lock wait.
-- Separate from the transcript-folder tables, which this migration leaves
-- unchanged.

-- CreateTable
CREATE TABLE "project_document_folder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webUrl" TEXT,
    "drivePath" TEXT,
    "siteId" TEXT,
    "siteName" TEXT,
    "libraryName" TEXT,
    "description" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "readerEpoch" INTEGER NOT NULL DEFAULT 0,
    "lastPassId" TEXT,
    "readStartedAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "lastListingComplete" BOOLEAN NOT NULL DEFAULT false,
    "pausedRemovalsCode" TEXT,
    "heldRemovalCount" INTEGER,
    "problemCode" TEXT,
    "nextReadAfter" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "project_document_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_document_folder_file" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "driveItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "size" BIGINT,
    "sourceModifiedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipCode" TEXT,
    "failureCode" TEXT,
    "contextId" TEXT,
    "storageKey" TEXT,
    "importedVersion" TEXT,
    "latestVersion" TEXT,
    "latestVersionSeenCount" INTEGER NOT NULL DEFAULT 0,
    "excludedVersion" TEXT,
    "missCount" INTEGER NOT NULL DEFAULT 0,
    "removalHeldAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "savedSourceType" TEXT,
    "savedAiInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "project_document_folder_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_document_folder_projectId_idx" ON "project_document_folder"("projectId");

-- CreateIndex
CREATE INDEX "project_document_folder_userId_idx" ON "project_document_folder"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_document_folder_projectId_driveId_itemId_key" ON "project_document_folder"("projectId", "driveId", "itemId");

-- CreateIndex
CREATE INDEX "project_document_folder_file_contextId_idx" ON "project_document_folder_file"("contextId");

-- CreateIndex
CREATE INDEX "project_document_folder_file_projectId_status_idx" ON "project_document_folder_file"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_document_folder_file_userId_idx" ON "project_document_folder_file"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_document_folder_file_folderId_driveItemId_key" ON "project_document_folder_file"("folderId", "driveItemId");

-- AddForeignKey
ALTER TABLE "project_document_folder" ADD CONSTRAINT "project_document_folder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_folder" ADD CONSTRAINT "project_document_folder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_folder" ADD CONSTRAINT "project_document_folder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_folder_file" ADD CONSTRAINT "project_document_folder_file_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "project_document_folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_folder_file" ADD CONSTRAINT "project_document_folder_file_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_folder_file" ADD CONSTRAINT "project_document_folder_file_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_folder_file" ADD CONSTRAINT "project_document_folder_file_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "project_document_asset" (
    "id" TEXT NOT NULL,
    "projectDocumentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_document_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_file" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_document_asset_projectDocumentId_idx" ON "project_document_asset"("projectDocumentId");

-- CreateIndex
CREATE INDEX "project_document_asset_userId_idx" ON "project_document_asset"("userId");

-- CreateIndex
CREATE INDEX "project_document_asset_organizationId_idx" ON "project_document_asset"("organizationId");

-- CreateIndex
CREATE INDEX "skill_file_skillId_idx" ON "skill_file"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_file_skillId_path_key" ON "skill_file"("skillId", "path");

-- AddForeignKey
ALTER TABLE "project_document_asset" ADD CONSTRAINT "project_document_asset_projectDocumentId_fkey" FOREIGN KEY ("projectDocumentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_asset" ADD CONSTRAINT "project_document_asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_asset" ADD CONSTRAINT "project_document_asset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_file" ADD CONSTRAINT "skill_file_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

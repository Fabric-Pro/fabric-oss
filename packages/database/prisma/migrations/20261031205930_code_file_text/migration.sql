-- CreateTable
CREATE TABLE "project_code_file" (
    "id" TEXT NOT NULL,
    "projectCodeIndexId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "path" TEXT NOT NULL,
    "blobSha" TEXT,
    "language" TEXT,
    "content" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_code_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_code_file_projectId_idx" ON "project_code_file"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_code_file_projectCodeIndexId_path_key" ON "project_code_file"("projectCodeIndexId", "path");

-- AddForeignKey
ALTER TABLE "project_code_file" ADD CONSTRAINT "project_code_file_projectCodeIndexId_fkey" FOREIGN KEY ("projectCodeIndexId") REFERENCES "project_code_index"("id") ON DELETE CASCADE ON UPDATE CASCADE;
